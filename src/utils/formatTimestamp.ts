const formatTimestamp = (timestamp = Date.now(), precision = 'millisecond') => {
    const date = new Date(timestamp);

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const formattedDate = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;

    switch (precision) {
        case 'second':
            return formattedDate;
        case 'millisecond':
            const ms = String(date.getMilliseconds()).padStart(3, '0');
            return `${formattedDate}.${ms}`;
        default:
            throw new Error('不支持的时间精度：' + precision);
    }
};

export default formatTimestamp;