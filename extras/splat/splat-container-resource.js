import {
    BoundingBox,
    ContainerResource,
    Entity
} from 'playcanvas';

import { Splat } from './splat.js';
import { SplatInstance } from './splat-instance.js';

const globalDebugRender = false;

class SplatContainerResource extends ContainerResource {
    device;

    splatData;

    splat;

    constructor(device, splatData) {
        super();

        this.device = device;
        this.splatData = splatData;
    }

    destroy() {
        this.device = null;
        this.splatData = null;
        this.splat?.destroy();
        this.splat = null;
    }

    createSplat() {
        if (!this.splat) {

            const splatData = this.splatData;

            const aabb = new BoundingBox();
            this.splatData.calcAabb(aabb);

            const splat = new Splat(this.device, splatData.numSplats, aabb);
            this.splat = splat;

            // texture data
            splat.updateColorData(splatData.getProp('f_dc_0'), splatData.getProp('f_dc_1'), splatData.getProp('f_dc_2'), splatData.getProp('opacity'));
            splat.updateScaleData(splatData.getProp('scale_0'), splatData.getProp('scale_1'), splatData.getProp('scale_2'));
            splat.updateRotationData(splatData.getProp('rot_0'), splatData.getProp('rot_1'), splatData.getProp('rot_2'), splatData.getProp('rot_3'));
            splat.updateCenterData(splatData.getProp('x'), splatData.getProp('y'), splatData.getProp('z'));

            // centers - constant buffer that is sent to the worker
            const x = splatData.getProp('x');
            const y = splatData.getProp('y');
            const z = splatData.getProp('z');

            const centers = new Float32Array(this.splatData.numSplats * 3);
            for (let i = 0; i < this.splatData.numSplats; ++i) {
                centers[i * 3 + 0] = x[i];
                centers[i * 3 + 1] = y[i];
                centers[i * 3 + 2] = z[i];
            }
            splat.centers = centers;
        }

        return this.splat;
    }

    instantiateModelEntity(/* options: any */) {
        return null;
    }

    instantiateRenderEntity(options) {

        // shared splat between instances
        const splat = this.createSplat();

        const debugRender = options?.debugRender ?? globalDebugRender;
        const cameraEntity = options?.cameraEntity;
        const splatInstance = new SplatInstance(splat, cameraEntity, debugRender);

        const entity = new Entity('Splat');
        entity.addComponent('render', {
            type: 'asset',
            meshInstances: [splatInstance.meshInstance],

            // shadows not supported
            castShadows: false
        });

        // set custom aabb
        entity.render.customAabb = splat.aabb.clone();

        // when the render component gets deleted, destroy the splat instance
        entity.render.system.on('beforeremove', (entity, component) => {
            splatInstance.destroy();
        }, this);

        return entity;
    }
}

export { SplatContainerResource };
