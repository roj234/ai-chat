
import router, {ROOT_DIR} from "./fs-api.js";
const base_uri = '/agent-api/v1/fs/';

export const mockFileSystem = {
    name: 'mock-fs-api',
    configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            if (req.url.startsWith(base_uri)) {
                const url = new URL(req.url, `http://${req.headers.host}`);
                let path = url.pathname.substring(base_uri.length);
                const query_parameter = Object.fromEntries(url.searchParams);

                let post_data = {};
                if (req.method === 'POST') {
                    const buffers = [];
                    for await (const chunk of req) {
                        buffers.push(chunk);
                    }
                    const rawBody = Buffer.concat(buffers).toString();
                    if (rawBody) {
                        post_data = JSON.parse(rawBody);
                    }
                }

                try {
                    const result = await router({
                        path,
                        query_parameter,
                        post_data
                    });
                    if (result == null) {
                        const err = new Error("Not Found");
                        err.statusCode = 404;
                        throw err;
                    }

                    if (result._data) {
                        res.setHeader('Content-Type', result._mime || 'application/octet-stream');
                        res.end(result._data);
                        return;
                    }

                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(result));
                } catch (err) {
                    if (404 !== err.statusCode)
                        console.error(err);

                    res.statusCode = err.statusCode || 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        detail: err.message.replace(ROOT_DIR, ""),
                        error: err.constructor.name
                    }));
                }

                return;
            }
            next();
        });
    },
};