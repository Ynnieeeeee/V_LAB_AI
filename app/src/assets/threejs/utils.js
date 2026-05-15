import * as three from 'three';

/**
 * Tính toán tỉ lệ scale để vật thể có kích thước tối đa là targetSize
 * @param {three.Group} model
 * @param {number} targetSize
 * @returns {number} scaleFactor
 */

export function autoScaleModel(model, targetSize){
    const box = new three.Box3().setFromObject(model);
    const size = box.getSize(new three.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    return targetSize / maxDim;
}

/**
 * Thực hiện hiệu ứng phóng to cho model từ 0 đến scaleFactor
 * @param {three.Group} model
 * @param {number} scaleFactor
 */

export function animateScale(model, scaleFactor){
    model.scale.set(0, 0, 0);
    let currentScale = 0;
    const speed = scaleFactor * .005;

    const animate = () => {
        currentScale += speed;

        if(currentScale < scaleFactor){
            model.scale.set(currentScale, currentScale, currentScale);
            requestAnimationFrame(animate);
        } else {
            model.scale.set(scaleFactor, scaleFactor, scaleFactor);
        }
    };
    animate();
};