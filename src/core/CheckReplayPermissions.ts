import { BiliLiveApi } from "./Api.js";



/**
 * 检查直播回放权限的类
* @class CheckReplayPermissions
* @description 用于检查用户是否有权限观看直播回放的类。
 */
class CheckReplayPermissions extends BiliLiveApi {

    /**
     * 检查用户是否有权限查看直播回放列表
    * @returns {Promise<boolean>}
     */
    public async checkReplayPermissions(): Promise<boolean> {
        // 获取直播回放权限的API请求
        const response = await this.getOtherSliceList();

        if (response && response?.code === 0)
            return true;

        return false;
    }

    /**
     * 检查用户是否有权限实时直播剪辑
     * - 检测前提：主播为开播状态或用户拥有查看直播回放列表权限
     */
    public async checkRealtimeEditingPermissions(): Promise<boolean> {
        const liveStatus = (await this.getLiveKey()) !== "0";

        // 开播状态下直接用相对应 liveKey 请求实时直播剪辑流接口判断
        if (liveStatus) {
            const response = await this.getUserClickSliceStream();
            if (response && response?.code === 0)
                return true;
            return false;
        }
        // 在未开播状态下通过回放列表当中某一天的liveKey判断
        else {
            const getOtherSliceList_res = await this.getOtherSliceList();
            if (getOtherSliceList_res && getOtherSliceList_res?.code === 0) {
                if (!getOtherSliceList_res?.data?.pagination?.total) {
                    return false;
                }

                const liveKey = getOtherSliceList_res?.data?.replay_info?.[0]?.live_key;
                if (!liveKey || liveKey === "0") {
                    return false;
                }

                this.liveKey = liveKey;
                const response = await this.getUserClickSliceStream();
                if (response && response?.code === 0)
                    return true;
            }
        }

        return false;
    }
}

export default CheckReplayPermissions;