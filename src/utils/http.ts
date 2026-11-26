import { delay } from "./delay.js";
import { handleError } from "./handleError.js";

export async function httpErrRepeat(
    res: { url: string } & RequestInit,
    maxRetries = 3,
    responseType: "json" | "text" | null = "json"
): Promise<any | Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            const { url, headers, method, body } = res;
            const options: RequestInit = { method };
            if (headers !== undefined) options.headers = headers;
            if (body !== undefined) options.body = body;
            const getData = await fetch(url, options);

            return responseType === "json" ? (await getData.json()) :
                responseType === "text" ? (await getData.text()) : getData;
        } catch (error) {
            const errMsg = handleError(error).errMsg;
            void global.logger.error(errMsg);
            if (attempt >= maxRetries) {
                throw new Error(`HTTP 错误请求次数超过阈值: ${errMsg}`);
            }
            await delay(1000 * (attempt + 1));
        }
    }
}
