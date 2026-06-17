import * as three from 'three';

const camera = new three.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

const cameraGroup = new three.Group();
cameraGroup.position.set(6, 0, 10);
cameraGroup.add(camera);

camera.position.set(0, 9.5, 0);

export function updateCameraAspect() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
}

export { camera, cameraGroup };
