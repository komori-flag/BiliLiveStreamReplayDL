import { delay } from "./delay.js";

export async function httpErrRepeat(
  responseData: { url: string } & RequestInit,
  repeatNum = 3,
  responseType: "json" | "text" = "json"
): Promise<any> {
  for (let i = 0; i < repeatNum; i++) {
    try {
      const res = await fetch(responseData.url, responseData);
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);

      return responseType === "json" ? await res.json() : await res.text();
    } catch (err) {
      if (i === repeatNum - 1)
        throw err;
      await delay(1000 * (i + 1));
    }
  }
}
