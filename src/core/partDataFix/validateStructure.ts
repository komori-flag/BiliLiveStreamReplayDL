// 分片结构校验聚合：worker 线程与主线程同步回退共用
//
// 只负责结构类检测（不含哈希），保证两条执行路径的判定完全一致。

import detectMoovIntegrity from './detectMoovIntegrity.js';
import detectMoofMdatFragments from './detectMoofMdatFragments.js';
import detectBoxSizeOrOffsetIssues from './detectBoxSizeOrOffsetIssues.js';
import detectTfdtContinuity from './detectTfdtContinuity.js';
import { parseTopLevelBoxes } from './mp4FragmentParser.js';

export interface StructureCheckOptions {
    moovIntegrity?: boolean;
    moofMdat?: boolean;
    boxSize?: boolean;
    tfdtContinuity?: boolean;
}

export interface StructureCheckResult {
    moovValid: boolean;
    moovReason?: string;
    anyMoofMdatIssue: boolean;
    anyBoxIssue: boolean;
    anyTfdtIssue: boolean;
    /** 不参与判定的告警（如首个视频样本非同步样本） */
    warnings: string[];
}

/** 按 checks 开关执行结构校验（未指定时默认全部开启） */
export function validateStructure(buf: Buffer, options: StructureCheckOptions = {}): StructureCheckResult {
    const enableMoov = options.moovIntegrity !== false;
    const enableMoofMdat = options.moofMdat !== false;
    const enableBoxSize = options.boxSize !== false;
    const enableTfdt = options.tfdtContinuity !== false;

    const moofMdatFragments = enableMoofMdat ? detectMoofMdatFragments(buf) : [];
    const anyMoofMdatIssue = enableMoofMdat
        ? moofMdatFragments.some(item => !item.moof?.ok || !item.mdat?.ok)
        : false;

    const boxIssues = enableBoxSize
        ? detectBoxSizeOrOffsetIssues(buf)
        : { issues: [] as Array<{ kind: string; detail: string; at?: number }> };
    const anyBoxIssue = enableBoxSize ? boxIssues.issues.length > 0 : false;

    const moovCheck = enableMoov
        ? detectMoovIntegrity(buf)
        : { valid: true, reason: 'skipped' };

    // 没有 moof 的 init-only 分片不做 tfdt 连续性判定
    let anyTfdtIssue = false;
    if (enableTfdt && parseTopLevelBoxes(buf).some(b => b.type === 'moof'))
        anyTfdtIssue = !detectTfdtContinuity(buf).ok;

    const warnings = moofMdatFragments
        .flatMap(fragment => fragment.warnings ?? []);

    return {
        moovValid: moovCheck.valid,
        moovReason: moovCheck.reason,
        anyMoofMdatIssue,
        anyBoxIssue,
        anyTfdtIssue,
        warnings,
    };
}
