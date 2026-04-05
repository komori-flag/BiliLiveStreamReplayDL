import { handleError } from './handleError.js';

const extractStackTracePath = (space = 2, startFrom: string = 'src\\') => {
  try {
    throw new Error("");
  } catch (e) {
    const full = handleError(e).stack
      .split(/\n+/)[space]
      .replace(/(^\s+|\s+$)/, "")
      .replace(/\(?([a-zA-Z]:\\[^\s:()]+\.\w+:\d+:\d+)\)?/, "$1");
    if (!startFrom)
      return full;
    const i = full.toLowerCase().indexOf(startFrom.toLowerCase());
    return i >= 0 ? full.slice(i) : full;
  }
};

export default extractStackTracePath;