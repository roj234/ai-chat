from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import asyncio
import uvicorn
import threading
import socket

import json
import sys
import time

import os
from loguru import logger

# 最大队列长度：控制总并发（适当限制，防止堆太多请求）
MAX_QUEUE_SIZE = 128

# 自动 batch 的最大 batch size：仅作为 sanity check（防止单个 batch 任务数过大）
MAX_BATCH_SIZE = 16

# 控制显存的大致上限：按 “token 向量数” 粗略估计
MAX_VECTOR_SIZE = 12288

# 自动 batch 的最大等待时间（秒），
# 比如 0.01 表示：最多等待 10ms 看是否能攒到更多请求一起跑
MAX_BATCH_WAIT = 0.01

# Each query must come with a one-sentence instruction that describes the task
QUERY_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"

def wrap_query(query: str) -> str:
    return QUERY_PREFIX + query

args = None

class Map(object):
    def __init__(self, **kwargs):
        self._dict = kwargs

    def __getattr__(self, item):
        return None if not item in self._dict else self._dict[item]


# ----------------- 模型加载 ----------------- #

model = None
tokenizer = None

logger.info("Loading torch")

import numpy as np

import torch
import torch.nn.functional as F

from torch import Tensor

def loadModel():
    global model, tokenizer

    from transformers import AutoTokenizer, AutoModel

    # attn_implementation="flash_attention_2" if args.flashattention else "eager",
    tokenizer = AutoTokenizer.from_pretrained(args.model, padding_side='right')
    model = AutoModel.from_pretrained(
        args.model,
        attn_implementation="sdpa",
        dtype=torch.bfloat16
    )

    model.eval().to(args.device)
    #model = torch.compile(model)

def last_token_pool(
    last_hidden_states: Tensor,
    attention_mask: Tensor
) -> Tensor:
    """
    提取每个序列的最后一个有效 token 的隐藏状态
    
    Args:
        last_hidden_states: [batch_size, seq_len, hidden_dim]
        attention_mask: [batch_size, seq_len]
    """
    # 计算每个序列的有效长度（非 padding token 数量）
    sequence_lengths = attention_mask.sum(dim=1) - 1  # [batch_size]
    
    batch_size = last_hidden_states.shape[0]
    device = last_hidden_states.device
    
    # 使用 gather 提取最后一个有效 token
    # 方法1：使用高级索引（推荐，更清晰）
    batch_indices = torch.arange(batch_size, device=device)
    return last_hidden_states[batch_indices, sequence_lengths]

# ----------------- OpenAI 兼容请求/响应模型 ----------------- #

from pydantic import BaseModel
from typing import List, Union

class EmbeddingRequest(BaseModel):
    model: str
    input: Union[str, List[str]]

class EmbeddingItem(BaseModel):
    object: str
    index: int
    embedding: List[float]

class EmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int

class EmbeddingResponse(BaseModel):
    object: str
    data: List[EmbeddingItem]
    model: str
    usage: EmbeddingUsage

# --------- 批处理/并发控制相关全局对象 --------- #

from dataclasses import dataclass, field
from typing import Any, Optional
import queue

@dataclass
class EmbeddingTask:
    """
    任务对象
    """
    text: str
    future: asyncio.Future[tuple[int, Tensor]] = field(default_factory=asyncio.Future)

request_queue: queue.Queue[EmbeddingTask] = queue.Queue(maxsize=MAX_QUEUE_SIZE)

def estimate_task_vector_size(task: EmbeddingTask) -> int:
    """
    对单个 task 进行粗 tokenization，估算加入后 vector 总大小。
    """
    if not task.text:
        return 0

    tokens = tokenizer(
        task.text,
        padding=False,
        truncation=True,
        max_length=args.context,
        return_attention_mask=False,
    )

    length = len(tokens["input_ids"])
    return min(length, args.context)

def batching_worker():
    """
    独立线程：从 request_queue 拉取任务，自动合并成 batch 调用模型。
    """
    logger.info("Batching worker started")

    first_task: EmbeddingTask = None
    while True:
        if first_task is None:
            # 1. 阻塞等待第一个任务
            first_task = request_queue.get(block=True)

        vector_size: int = estimate_task_vector_size(first_task)
        batch_tasks: list[EmbeddingTask] = [first_task]
        batch_inputs: list[str] = [first_task.text]

        first_task = None

        # 2. 在一个短时间窗口内继续拿更多任务，组成一个 batch
        start_time = time.time()
        while len(batch_inputs) < MAX_BATCH_SIZE and \
              len(batch_inputs) * vector_size < MAX_VECTOR_SIZE:
            timeout = MAX_BATCH_WAIT - (time.time() - start_time)
            if timeout <= 0:
                break

            try:
                task = request_queue.get(block=True, timeout=timeout)

                new_vector_size = estimate_task_vector_size(task)
                if new_vector_size * vector_size < MAX_VECTOR_SIZE:
                    batch_tasks.append(task)
                    batch_inputs.append(task.text)
                    vector_size = max(vector_size, new_vector_size)
                else:
                    # push first
                    first_task = task
                    break
            except queue.Empty:
                break

        #logger.debug(f"Batch size {len(batch_inputs)}, mem {len(batch_inputs) * vector_size}")

        try:
            tokens = tokenizer(
                batch_inputs,
                padding=len(batch_inputs) > 1,
                truncation=True,
                max_length=vector_size,
                return_tensors="pt",
            ).to(args.device)

            # 计算每个 input 的 token 数（非 padding）
            # tokens["attention_mask"] 形状: [N, L]
            # 按行求和得到每个样本有效 token 数
            token_counts = tokens["attention_mask"].sum(dim=1).cpu().tolist()  # list[int]

            with torch.no_grad():
                outputs = model(**tokens)
                embeddings = last_token_pool(outputs.last_hidden_state, tokens["attention_mask"])

                # normalize embeddings
                embeddings = F.normalize(embeddings, p=2, dim=1)

            embeddings = embeddings.cpu()
        except Exception as e:
            # 如果 batch 里整体失败，给每个 task 塞 error
            logger.exception("Batch inference failed: {}", e)
            for t in batch_tasks:
                event_loop.call_soon_threadsafe(t.future.set_exception, e)
            continue

        # 4. 完成任务
        offset = 0
        for t in batch_tasks:
            token_count = token_counts[offset]
            embedding = embeddings[offset]
            offset += 1

            event_loop.call_soon_threadsafe(t.future.set_result, (token_count, embedding))

# ----------------- API 应用 ----------------- #

async def create_embeddings(req: EmbeddingRequest):
    if isinstance(req.input, str):
        inputs = [req.input]
    else:
        inputs = list(req.input)

    loop = asyncio.get_running_loop()
    futures: list[asyncio.Future] = []

    for idx, text in enumerate(inputs):
        fut = loop.create_future()
        task = EmbeddingTask(
            text=text,
            future=fut
        )
        request_queue.put(task)
        futures.append(fut)

    # 等待所有子任务完成
    results = await asyncio.gather(*futures)

    # results: List[(prompt_tokens, embedding)]
    data_items: list[EmbeddingItem] = []
    total_prompt_tokens = 0

    # 保证按原顺序 index 输出
    for idx, (prompt_tokens, emb) in enumerate(results):
        total_prompt_tokens += prompt_tokens
        data_items.append(EmbeddingItem(
            object="embedding",
            index=idx,
            embedding=emb.tolist(),
        ))

    return EmbeddingResponse(
        object="list",
        data=data_items,
        model=req.model,
        usage=EmbeddingUsage(
            prompt_tokens=total_prompt_tokens,
            total_tokens=total_prompt_tokens,
        ),
    )

async def create_embeddings_raw(inputs: List[str]):
    loop = asyncio.get_running_loop()
    futures: list[asyncio.Future] = []

    for text in inputs:
        fut = loop.create_future()
        task = EmbeddingTask(
            text=text,
            future=fut,
        )

        request_queue.put(task)
        futures.append(fut)

    results = await asyncio.gather(*futures)
    return torch.stack([emb for _, emb in results])

app = FastAPI()
event_loop = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],               # 和你现在一样，允许所有域名
    allow_credentials=True,
    allow_methods=["*"],               # 允许所有方法
    allow_headers=["*"],               # 允许所有头，等价于你现在的写法
)

@app.on_event("startup")
async def on_startup():
    global event_loop
    event_loop = asyncio.get_running_loop()

    logger.info("正在预热模型")

    input_texts = [
        wrap_query('What is the capital of China?'),
        wrap_query('Explain gravity'),
        "The capital of China is Beijing.",
        "Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun."
    ]

    # Tokenize the input texts
    embeddings = await create_embeddings_raw(input_texts)

    scores = (embeddings[:2] @ embeddings[2:].T)
    logger.debug(scores.tolist())
    # [[0.7645568251609802, 0.14142508804798126], [0.13549736142158508, 0.5999549627304077]]

@app.post("/api/v1/embeddings")
async def api_embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
    resp = await create_embeddings(request)
    return resp

@app.post("/api/v1/embeddings/raw")
async def api_embeddings_raw(request: Request):
    body = await request.body()
    # todo pre-check ??
    if len(body) > 1024 * 1024:
        raise HTTPException(status_code=413, detail="Payload too large")

    text = body.decode("utf-8")

    emb = await create_embeddings_raw([text])
    data = emb[0].numpy().astype(np.float16).tobytes()
    return Response(content=data, media_type="application/octet-stream")


def is_port_in_use(portNum: int):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('localhost', portNum)) == 0

def main():
    args.device = "cuda" if torch.cuda.is_available() else "cpu"

    logger.info("正在加载模型")
    loadModel()

    # ---------- 启动批处理工作线程 ----------
    worker_thread = threading.Thread(target=batching_worker, daemon=True)
    worker_thread.start()
    # ------------------------------------

    logger.info("正在启动服务器")

    addr = args.host
    port = args.port

    if is_port_in_use(port):
        print(f"Warning: Port {port} already used by another program.")

    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    args = Map(
        model = os.getenv("EMBEDDING_MODEL", "Qwen3-Embedding-0.6B"),
        context = 6144,

        debug = False,

        host = 'localhost',
        port = 5002,

        # 1MB post size
        post_max_size = 1
    )
    main()