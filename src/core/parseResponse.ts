type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';

export const parseResponse = async <T>(res: Response, responseType: ResponseType): Promise<T> => {
    let data: T;
    switch (responseType) {
        case 'json':
            data = await res.json() as T;
            break;
        case 'text':
            data = await res.text() as T;
            break;
        case 'arrayBuffer':
            data = await res.arrayBuffer() as T;
            break;
        case 'blob':
            data = await res.blob() as T;
            break;
        default:
            throw new Error(`未知的 responseType: ${responseType}`);
    }
    return data;
}