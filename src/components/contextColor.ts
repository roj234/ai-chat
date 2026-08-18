
type RGB = [number, number, number];

interface ColorStep {
    step: number; // 0 ~ 1 之间的阈值
    color: RGB;
}

const COLOR_STEPS: ColorStep[] = [
    { step: 0.0,  color: [6, 182, 212] },
    { step: 0.25, color: [16, 185, 129] },
    { step: 0.75, color: [245, 158, 11] },
    { step: 0.95,  color: [239, 68, 68] },
];

/**
 * 线性插值辅助计算
 */
const lerp = (start: number, end: number, factor: number): number => start + (end - start) * factor;

/**
 * 根据 0 ~ 1 的用量比例计算当前平滑颜色
 * @returns CSS rgba 颜色字符串
 */
export const getContextStrokeColor = (progress: number, alpha: number = 1): string => {
    let endIndex = COLOR_STEPS.length - 1;
    for (let i = 0; i < endIndex; i++) {
        if (progress >= COLOR_STEPS[i].step && progress <= COLOR_STEPS[i + 1].step) {
            endIndex = i;
            break;
        }
    }

    const start = COLOR_STEPS[endIndex];
    const end = COLOR_STEPS[endIndex + 1] || start;

    const delta = end.step - start.step;
    const localFactor = delta === 0 ? 0 : (progress - start.step) / delta;

    const r = Math.round(lerp(start.color[0], end.color[0], localFactor));
    const g = Math.round(lerp(start.color[1], end.color[1], localFactor));
    const b = Math.round(lerp(start.color[2], end.color[2], localFactor));

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};