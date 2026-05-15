import * as three from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function initLights(scene, renderer) {
    const ambientLight = new three.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const directionalLight = new three.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(5, 10, 5);
    directionalLight.castShadow = true;
    
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);

    const pmremGenerator = new three.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    
    // Khởi tạo môi trường phản xạ (Môi trường Studio) cho vật liệu PBR (Kim loại, Thủy tinh)
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    
    return { ambientLight, directionalLight };
}