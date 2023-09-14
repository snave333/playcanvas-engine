import { Color } from '../../core/math/color.mjs';

import { ADDRESS_CLAMP_TO_EDGE, FILTER_NEAREST, PIXELFORMAT_RGBA8 } from '../../platform/graphics/constants.mjs';
import { GraphicsDevice } from '../../platform/graphics/graphics-device.mjs';
import { RenderTarget } from '../../platform/graphics/render-target.mjs';
import { Texture } from '../../platform/graphics/texture.mjs';
import { DebugGraphics } from '../../platform/graphics/debug-graphics.mjs';

import { SHADER_PICK } from '../../scene/constants.mjs';
import { Camera } from '../../scene/camera.mjs';
import { Layer } from '../../scene/layer.mjs';

import { getApplication } from '../globals.mjs';
import { Debug, DebugHelper } from '../../core/debug.mjs';
import { BlendState } from '../../platform/graphics/blend-state.mjs';
import { RenderPass } from '../../platform/graphics/render-pass.mjs';

const tempSet = new Set();
const tempMeshInstances = [];

/**
 * Picker object used to select mesh instances from screen coordinates.
 *
 * @property {number} width Width of the pick buffer in pixels (read-only).
 * @property {number} height Height of the pick buffer in pixels (read-only).
 * @property {RenderTarget} renderTarget The render target used by the picker internally
 * (read-only).
 *
 * @category Graphics
 */
class Picker {
    // internal render target
    renderTarget = null;

    // uniform for the mesh index encoded into rgba
    pickColor = new Float32Array(4);

    // mapping table from ids to meshInstances
    mapping = new Map();

    /**
     * Create a new Picker instance.
     *
     * @param {import('../app-base.mjs').AppBase} app - The application managing this picker
     * instance.
     * @param {number} width - The width of the pick buffer in pixels.
     * @param {number} height - The height of the pick buffer in pixels.
     */
    constructor(app, width, height) {
        if (app instanceof GraphicsDevice) {
            app = getApplication();
            Debug.deprecated('pc.Picker now takes pc.AppBase as first argument. Passing pc.GraphicsDevice is deprecated.');
        }

        // Note: The only reason this class needs the app is to access the renderer. Ideally we remove this dependency and move
        // the Picker from framework to the scene level, or even the extras.
        this.renderer = app.renderer;
        this.device = app.graphicsDevice;

        this.width = 0;
        this.height = 0;
        this.resize(width, height);
    }

    /**
     * Return the list of mesh instances selected by the specified rectangle in the previously
     * prepared pick buffer.The rectangle using top-left coordinate system.
     *
     * @param {number} x - The left edge of the rectangle.
     * @param {number} y - The top edge of the rectangle.
     * @param {number} [width] - The width of the rectangle.
     * @param {number} [height] - The height of the rectangle.
     * @returns {import('../../scene/mesh-instance.mjs').MeshInstance[]} An array of mesh instances
     * that are in the selection.
     * @example
     * // Get the selection at the point (10,20)
     * const selection = picker.getSelection(10, 20);
     * @example
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * const selection = picker.getSelection(10, 20, 10, 20);
     */
    getSelection(x, y, width, height) {
        const device = this.device;

        if (typeof x === 'object') {
            Debug.deprecated(`Picker.getSelection:param 'rect' is deprecated, use 'x, y, width, height' instead.`);

            const rect = x;
            x = rect.x;
            y = rect.y;
            width = rect.width;
            height = rect.height;
        } else {
            y = this.renderTarget.height - (y + (height || 1));
        }

        // make sure we have nice numbers to work with
        x = Math.floor(x);
        y = Math.floor(y);
        width = Math.floor(Math.max(width || 1, 1));
        height = Math.floor(Math.max(height || 1, 1));

        // read pixels from the render target
        device.setRenderTarget(this.renderTarget);
        device.updateBegin();

        const pixels = new Uint8Array(4 * width * height);
        device.readPixels(x, y, width, height, pixels);

        device.updateEnd();

        const mapping = this.mapping;
        for (let i = 0; i < width * height; i++) {
            const r = pixels[4 * i + 0];
            const g = pixels[4 * i + 1];
            const b = pixels[4 * i + 2];
            const a = pixels[4 * i + 3];
            const index = a << 24 | r << 16 | g << 8 | b;

            // White is 'no selection'
            if (index !== 0xffffffff) {
                tempSet.add(mapping.get(index));
            }
        }

        // return the content of the set as an array
        const selection = [];
        tempSet.forEach(meshInstance => selection.push(meshInstance));
        tempSet.clear();

        return selection;
    }

    allocateRenderTarget() {

        const colorBuffer = new Texture(this.device, {
            format: PIXELFORMAT_RGBA8,
            width: this.width,
            height: this.height,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            name: 'pick'
        });

        this.renderTarget = new RenderTarget({
            colorBuffer: colorBuffer,
            depth: true
        });
    }

    releaseRenderTarget() {
        if (this.renderTarget) {
            this.renderTarget.destroyTextureBuffers();
            this.renderTarget.destroy();
            this.renderTarget = null;
        }
    }

    /**
     * Primes the pick buffer with a rendering of the specified models from the point of view of
     * the supplied camera. Once the pick buffer has been prepared, {@link Picker#getSelection} can
     * be called multiple times on the same picker object. Therefore, if the models or camera do
     * not change in any way, {@link Picker#prepare} does not need to be called again.
     *
     * @param {import('../components/camera/component.mjs').CameraComponent} camera - The camera
     * component used to render the scene.
     * @param {import('../../scene/scene.mjs').Scene} scene - The scene containing the pickable mesh
     * instances.
     * @param {Layer[]} [layers] - Layers from which objects will be picked. If not supplied, all layers of the specified camera will be used.
     */
    prepare(camera, scene, layers) {

        // handle deprecated arguments
        if (camera instanceof Camera) {
            Debug.deprecated('pc.Picker#prepare now takes pc.CameraComponent as first argument. Passing pc.Camera is deprecated.');

            // Get the camera component
            camera = camera.node.camera;
        }

        if (layers instanceof Layer) {
            layers = [layers];
        }

        // make the render target the right size
        if (!this.renderTarget || (this.width !== this.renderTarget.width || this.height !== this.renderTarget.height)) {
            this.releaseRenderTarget();
            this.allocateRenderTarget();
        }

        // clear registered meshes mapping
        this.mapping.clear();

        // create a render pass
        const device = this.device;
        const renderPass = new RenderPass(device, () => {

            DebugGraphics.pushGpuMarker(device, 'PICKER');

            const renderer = this.renderer;
            const srcLayers = scene.layers.layerList;
            const subLayerEnabled = scene.layers.subLayerEnabled;
            const isTransparent = scene.layers.subLayerList;

            const pickColorId = device.scope.resolve('uColor');
            const pickColor = this.pickColor;

            for (let i = 0; i < srcLayers.length; i++) {
                const srcLayer = srcLayers[i];

                // skip the layer if it does not match the provided ones
                if (layers && layers.indexOf(srcLayer) < 0) {
                    continue;
                }

                if (srcLayer.enabled && subLayerEnabled[i]) {

                    // if the layer is rendered by the camera
                    const layerCamId = srcLayer.cameras.indexOf(camera);
                    if (layerCamId >= 0) {

                        // if the layer clears the depth
                        if (srcLayer._clearDepthBuffer) {
                            renderer.clear(camera.camera, false, true, false);
                        }

                        const culledInstances = srcLayer.getCulledInstances(camera.camera);
                        const meshInstances = isTransparent[i] ? culledInstances.transparent : culledInstances.opaque;

                        // only need mesh instances with a pick flag
                        for (let j = 0; j < meshInstances.length; j++) {
                            const meshInstance = meshInstances[j];
                            if (meshInstance.pick) {
                                tempMeshInstances.push(meshInstance);

                                // keep the index -> meshInstance index mapping
                                this.mapping.set(meshInstance.id, meshInstance);
                            }
                        }

                        const lights = [[], [], []];
                        renderer.renderForward(camera.camera, tempMeshInstances, lights, SHADER_PICK, (meshInstance) => {
                            const miId = meshInstance.id;
                            pickColor[0] = ((miId >> 16) & 0xff) / 255;
                            pickColor[1] = ((miId >> 8) & 0xff) / 255;
                            pickColor[2] = (miId & 0xff) / 255;
                            pickColor[3] = ((miId >> 24) & 0xff) / 255;
                            pickColorId.setValue(pickColor);
                            device.setBlendState(BlendState.NOBLEND);
                        });

                        tempMeshInstances.length = 0;
                    }
                }
            }

            DebugGraphics.popGpuMarker(device);
        });

        DebugHelper.setName(renderPass, `RenderPass-Picker`);
        renderPass.init(this.renderTarget);

        // set up clears
        renderPass.colorOps.clearValue = Color.WHITE;
        renderPass.colorOps.clear = true;
        renderPass.depthStencilOps.clearDepth = true;

        // render the pass to update the render target
        renderPass.render();
    }

    /**
     * Sets the resolution of the pick buffer. The pick buffer resolution does not need to match
     * the resolution of the corresponding frame buffer use for general rendering of the 3D scene.
     * However, the lower the resolution of the pick buffer, the less accurate the selection
     * results returned by {@link Picker#getSelection}. On the other hand, smaller pick buffers
     * will yield greater performance, so there is a trade off.
     *
     * @param {number} width - The width of the pick buffer in pixels.
     * @param {number} height - The height of the pick buffer in pixels.
     */
    resize(width, height) {
        this.width = Math.floor(width);
        this.height = Math.floor(height);
    }
}

export { Picker };