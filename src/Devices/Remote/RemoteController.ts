import Colors from "colors";

import { Button, DeviceState, DeviceType } from "@mkellsy/hap-device";

import { AreaAddress } from "../../Response/AreaAddress";
import { ButtonMap } from "./ButtonMap";
import { ButtonStatus } from "../../Response/ButtonStatus";
import { Common } from "../Common";
import { DeviceAddress } from "../../Response/DeviceAddress";
import { Processor } from "../Processor/Processor";
import { Remote } from "./Remote";
import { Trigger } from "./Trigger";
import { TriggerController } from "./TriggerController";

/**
 * Defines a Pico remote device.
 * @public
 */
export class RemoteController extends Common<DeviceState> implements Remote {
    public readonly buttons: Button[] = [];

    private triggers: Map<string, Trigger> = new Map();

    /**
     * Creates a Pico remote device.
     *
     * ```js
     * const remote = new Remote(processor, area, device);
     * ```
     *
     * @param processor The processor this device belongs to.
     * @param area The area this device is in.
     * @param device A refrence to this device.
     */
    constructor(processor: Processor, area: AreaAddress, device: DeviceAddress) {
        super(DeviceType.Remote, processor, area, device, { state: "Unknown" });

        this.ready = this.processor
            .buttons(this.address)
            .then(async (groups) => {
                if (!Array.isArray(groups)) {
                    throw new Error(`button groups not an array for ${device.DeviceType} ${this.address.href}`);
                }

                const map = ButtonMap.get(device.DeviceType);

                if (map == null) {
                    this.log.warn(`no ButtonMap for DeviceType=${device.DeviceType}; buttons will be unmapped`);
                }

                for (let i = 0; i < groups.length; i++) {
                    for (let j = 0; j < groups[i].Buttons?.length; j++) {
                        const button = groups[i].Buttons[j];
                        const mapped = map?.get(button.ButtonNumber);
                        const index = (mapped?.[0] as number | undefined) ?? button.ButtonNumber + 1;
                        const raiseLower = (mapped?.[1] as boolean | undefined) ?? false;

                        const trigger = new TriggerController(this.processor, button, index, { raiseLower });

                        trigger.on("Press", (button): void => {
                            this.emit("Action", this, button, "Press");

                            setTimeout(() => this.emit("Action", this, button, "Release"), 100);
                        });

                        trigger.on("DoublePress", (button): void => {
                            this.emit("Action", this, button, "DoublePress");

                            setTimeout(() => this.emit("Action", this, button, "Release"), 100);
                        });

                        trigger.on("LongPress", (button): void => {
                            this.emit("Action", this, button, "LongPress");

                            setTimeout(() => this.emit("Action", this, button, "Release"), 100);
                        });

                        this.triggers.set(button.href, trigger);
                        this.buttons.push(trigger.definition);

                        try {
                            await this.processor.subscribe<ButtonStatus>(
                                { href: `${button.href}/status/event` },
                                (status: ButtonStatus): void => this.triggers.get(button.href)!.update(status),
                            );
                        } catch (error) {
                            this.log.error(
                                Colors.red(error instanceof Error ? error.message : String(error)),
                            );
                        }
                    }
                }

                this.log.info(
                    `remote buttons ready count=${this.buttons.length} type=${device.DeviceType} href=${this.address.href}`,
                );
            })
            .catch((error: Error) => {
                this.log.error(Colors.red(error.message));
                throw error;
            });
    }

    /**
     * Recieves a state response from the processor (not supported).
     */
    public update(): void {
        this.initialized = true;
    }

    /**
     * Controls this device (not supported).
     */
    public set = (): Promise<void> => Promise.resolve();
}
