import { CULLFACE_FRONT } from '../platform/graphics/constants.mjs';
import { ShaderProcessorOptions } from '../platform/graphics/shader-processor-options.mjs';

import { GAMMA_NONE, GAMMA_SRGBHDR, LAYERID_SKYBOX, SHADER_FORWARDHDR, TONEMAP_LINEAR } from './constants.mjs';
import { createBox } from './procedural.mjs';
import { GraphNode } from './graph-node.mjs';
import { Material } from './materials/material.mjs';
import { MeshInstance } from './mesh-instance.mjs';
import { getProgramLibrary } from './shader-lib/get-program-library.mjs';
import { skybox } from './shader-lib/programs/skybox.mjs';

/**
 * A visual representation of the sky.
 *
 * @ignore
 */
class Sky {
    /**
     * Mesh instance representing the visuals of the sky.
     *
     * @type {MeshInstance}
     */
    meshInstance;

    /**
     * @param {import('../platform/graphics/graphics-device.mjs').GraphicsDevice} device - The
     * graphics device.
     * @param {import('./scene.mjs').Scene} scene - The scene owning the sky.
     * @param {import('../platform/graphics/texture.mjs').Texture} texture - The texture of the sky.
     */
    constructor(device, scene, texture) {

        const material = new Material();

        material.getShaderVariant = function (dev, sc, defs, unused, pass, sortedLights, viewUniformFormat, viewBindGroupFormat) {

            const options = {
                pass: pass,
                encoding: texture.encoding,
                useIntensity: scene.skyboxIntensity !== 1 || scene.physicalUnits,
                gamma: (pass === SHADER_FORWARDHDR ? (scene.gammaCorrection ? GAMMA_SRGBHDR : GAMMA_NONE) : scene.gammaCorrection),
                toneMapping: (pass === SHADER_FORWARDHDR ? TONEMAP_LINEAR : scene.toneMapping)
            };

            if (texture.cubemap) {
                options.type = 'cubemap';
                options.mip = texture.fixCubemapSeams ? scene.skyboxMip : 0;
                options.fixSeams = texture.fixCubemapSeams;
            } else {
                options.type = 'envAtlas';
            }

            const processingOptions = new ShaderProcessorOptions(viewUniformFormat, viewBindGroupFormat);

            const library = getProgramLibrary(device);
            library.register('skybox', skybox);
            return library.getProgram('skybox', options, processingOptions);
        };

        if (texture.cubemap) {
            material.setParameter('texture_cubeMap', texture);
        } else {
            material.setParameter('texture_envAtlas', texture);
            material.setParameter('mipLevel', scene._skyboxMip);
        }

        material.cull = CULLFACE_FRONT;
        material.depthWrite = false;

        const skyLayer = scene.layers.getLayerById(LAYERID_SKYBOX);
        if (skyLayer) {
            const node = new GraphNode('Skybox');
            const mesh = createBox(device);
            const meshInstance = new MeshInstance(mesh, material, node);
            this.meshInstance = meshInstance;

            meshInstance.cull = false;
            meshInstance._noDepthDrawGl1 = true;

            // disable picker, the material has custom update shader and does not handle picker variant
            meshInstance.pick = false;

            skyLayer.addMeshInstances([meshInstance]);
            this.skyLayer = skyLayer;
        }
    }

    destroy() {
        if (this.meshInstance) {
            if (this.skyLayer) {
                this.skyLayer.removeMeshInstances([this.meshInstance]);
            }
            this.meshInstance.destroy();
            this.meshInstance = null;
        }
    }
}

export { Sky };