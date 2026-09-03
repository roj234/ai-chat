
/** NULL owner 值（`0`）。追加时传入 `0` 会被视为 NULL 并拒绝。 */
export const NULL_OWNER: 0;

/**
 * 一条日志（从数据库读取的结果）。
 */
export interface LogItem {
  /** 行号（= db.idx 中的物理行下标） */
  id: number;
  /** UNIX 毫秒时间戳（u48） */
  time: number;
  /** owner 业务主键；NULL 行省略该字段 */
  owner?: number;
  /** 原始二进制负载 */
  data: Uint8Array;
}

/**
 * 一段连续行区间（`findByTime` 的返回值）。
 */
export interface LogRange {
  /** 区间首行 id（含） */
  firstId: number;
  /** 区间末行 id（含） */
  lastId: number;
  /** 首行的 owner；NULL 行省略 */
  startOwnerId?: number;
  /** 末行的 owner；NULL 行省略 */
  endOwnerId?: number;
  /** 首行 data 在 db.dat 中的起始字节偏移 */
  offset: number;
  /** 区间内所有 data 的连续字节总长 */
  length: number;
}

/**
 * `findByTime` 的可选约束。
 */
export interface FindByTimeOptions {
  /** 闭区间下界：结果首行（跳过 NULL 行）的 owner 必须 >= 该值 */
  startOwnerId?: number;
  /** 闭区间上界：结果末行（跳过 NULL 行）的 owner 必须 <= 该值 */
  endOwnerId?: number;
}

/**
 * `TSDB.create` 的选项。当前实现预留，暂无实际字段。
 */
export interface TSDBOptions {
  [key: string]: unknown;
}

export class TSDB {
  private constructor(options?: TSDBOptions);

  /** 当前行数。 */
  get size(): number;

  /**
   * 打开文件读写句柄；若文件不存在则先创建空文件，再以 `r+` 打开。
   *
   * @param filePath 数据库根路径（不含扩展名；会自动追加 `.idx` / `.dat`）。
   * @param options 预留选项。
   */
  static create(filePath: string, options?: TSDBOptions): Promise<TSDB>;

  /**
   * 追加一行原始负载。
   *
   * @param data 原始负载，长度 `<= 255`；超长抛 `RangeError` 且不落盘。
   * @param owner u32 业务主键；`0` 视为 NULL。唯一性由调用方保证。
   * @param time UNIX 毫秒时间戳（u48），缺省取当前时间。
   * @returns 新行 id（= 追加前 rowCount）。
   */
  append(data: Uint8Array, owner: number, time?: number): Promise<number>;

  /**
   * 按行号读取一条日志。
   *
   * @param id 行号。
   */
  get(id: number): Promise<LogItem | undefined>;

  /**
   * 按 owner 二分定位并读取该 owner 的记录。
   *
   * @param owner 业务主键；`0`（`NULL_OWNER`）直接返回 `undefined`。
   */
  getByOwnerId(owner: number): Promise<LogItem | undefined>;

  /**
   * 按时间区间查询，返回连续行区间（零拷贝元数据）。
   *
   * @param startTime 起始时间（含），u48。
   * @param endTime 结束时间（含），u48。
   * @param options owner 约束。
   * @returns 无匹配返回 `null`。
   */
  findByTime(
    startTime: number,
    endTime: number,
    options?: FindByTimeOptions,
  ): Promise<LogRange | null>;

  /**
   * 将 db.dat 的一段区间作为可读流输出。
   *
   * @param offset 起始字节偏移。
   * @param length 读取长度；缺省则读到文件末尾。
   */
  createReadStream(offset: number, length?: number): import('node:stream').Readable;

  /** 关闭底层文件句柄。 */
  close(): Promise<void>;
}
