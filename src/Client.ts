import { get as getLogger } from "js-logger";

import Colors from "colors";

import {
    Action,
    Address,
    AreaStatus,
    Button,
    Device,
    DeviceType,
    DeviceState,
    HostAddressFamily,
    TimeclockStatus,
    ZoneStatus,
} from "@mkellsy/hap-device";

import { EventEmitter } from "@mkellsy/event-emitter";

import { AreaAddress } from "./Response/AreaAddress";
import { Connection } from "./Connection/Connection";
import { Context } from "./Connection/Context";
import { ControlStation } from "./Response/ControlStation";
import { DeviceAddress } from "./Response/DeviceAddress";
import { Discovery } from "./Connection/Discovery";
import { Processor } from "./Devices/Processor/Processor";
import { ProcessorController } from "./Devices/Processor/ProcessorController";
import { ProcessorAddress } from "./Response/ProcessorAddress";

import { createDevice, isAddressable, parseDeviceType } from "./Devices/Devices";
import { probeProcessorMetadata } from "./Connection/MetadataProbe";

const log = getLogger("Client");

const RETRY_BACKOFF_DURATION = 5_000;

/**
 * Creates an object that represents a single location, with a single network.
 * @public
 */
export class Client extends EventEmitter<{
    Action: (device: Device, button: Button, action: Action) => void;
    Available: (devices: Device[]) => void;
    Message: (response: Response) => void;
    Update: (device: Device, state: DeviceState) => void;
}> {
    private context: Context;
    private refresh: boolean;

    private discovery: Discovery;
    private discovered: Map<string, Processor> = new Map();
    private areaPaths: Map<string, string> = new Map();

    /**
     * Creates a location object and starts mDNS discovery.
     *
     * ```js
     * const location = new Client();
     *
     * location.on("Avaliable", (devices: Device[]) => {  });
     * ```
     *
     * @param refresh If true, this will ignore any cache and reload.
     */
    constructor(refresh?: boolean) {
        super(Infinity);

        this.context = new Context();
        this.discovery = new Discovery();
        this.refresh = refresh === true;

        log.info(
            `Client start refresh=${this.refresh} paired=[${this.context.processors.join(", ") || "none"}]`,
        );

        this.discovery.on("Discovered", this.onDiscovered).search();
    }

    /**
     * A list of processors in this location.
     *
     * @returns A string array of processor ids.
     */
    public get processors(): string[] {
        return [...this.discovered.keys()];
    }

    /**
     * Fetch a processor from this location.
     *
     * @param id The processor id to fetch.
     *
     * @returns A processor object or undefined if it doesn't exist.
     */
    public processor(id: string): Processor | undefined {
        return this.discovered.get(id);
    }

    /**
     * Closes all connections for a location and stops searching.
     */
    public close(): void {
        this.discovery.stop();

        for (const processor of this.discovered.values()) {
            processor.disconnect();
        }

        this.discovered.clear();
    }

    /*
     * Builds "House / Floor / Room" paths for every area href.
     */
    private rebuildAreaPaths(areas: AreaAddress[]): void {
        const byHref = new Map(areas.map((area) => [area.href, area]));
        this.areaPaths.clear();

        for (const area of areas) {
            const names: string[] = [];
            let current: string | undefined = area.href;
            const seen = new Set<string>();

            while (current != null && !seen.has(current)) {
                seen.add(current);
                const node = byHref.get(current);

                if (node == null) break;

                names.unshift(node.Name);
                current = node.Parent?.href;
            }

            this.areaPaths.set(area.href, names.join(" / ") || area.Name);
        }
    }

    /*
     * Annotates an area with its full hierarchy path for device constructors.
     */
    private withAreaPath(area: AreaAddress): AreaAddress & { Path: string } {
        return {
            ...area,
            Path: this.areaPaths.get(area.href) || area.Name,
        };
    }

    /*
     * Discovers all available zones on this processor. In other systems this
     * is the device.
     */
    private discoverZones(processor: Processor, area: AreaAddress): Promise<void> {
        return new Promise((resolve) => {
            if (!area.IsLeaf) return resolve();

            const areaWithPath = this.withAreaPath(area);

            processor
                .zones(area)
                .then((zones) => {
                    for (const zone of zones) {
                        const device = createDevice(processor, areaWithPath, zone)
                            .on("Update", this.onDeviceUpdate)
                            .on("Action", this.onDeviceAction);

                        processor.devices.set(zone.href, device);
                    }

                    resolve();
                })
                .catch(() => resolve());
        });
    }

    /*
     * Discovers all available timeclocks. Timeclocks are schedules, and
     * sometimes are used as vurtual switches.
     */
    private discoverTimeclocks(processor: Processor): Promise<void> {
        return new Promise((resolve) => {
            processor
                .timeclocks()
                .then((timeclocks) => {
                    for (const timeclock of timeclocks) {
                        const device = createDevice(
                            processor,
                            {
                                href: timeclock.href,
                                Name: timeclock.Name,
                                ControlType: "Timeclock",
                                Parent: timeclock.Parent,
                                IsLeaf: true,
                                AssociatedZones: [],
                                AssociatedControlStations: [],
                                AssociatedOccupancyGroups: [],
                                Path: timeclock.Name,
                            } as AreaAddress & { Path: string },
                            { ...timeclock, ControlType: "Timeclock" },
                        ).on("Update", this.onDeviceUpdate);

                        processor.devices.set(timeclock.href, device);
                    }

                    resolve();
                })
                .catch(() => resolve());
        });
    }

    /*
     * Discovers all keypads and remotes. These are ganged devices.
     */
    private discoverControls(processor: Processor, area: AreaAddress): Promise<void> {
        return new Promise((resolve) => {
            if (!area.IsLeaf) return resolve();

            const areaWithPath = this.withAreaPath(area);

            processor
                .controls(area)
                .then(async (controls) => {
                    if (controls == null || controls.length === 0) {
                        return resolve();
                    }

                    // Wait for every control station — previously resolved after the first,
                    // which dropped later Picos in multi-station rooms.
                    await Promise.all(
                        controls.map(async (control) => {
                            const positions = await this.discoverPositions(processor, control);

                            for (const position of positions) {
                                const type = parseDeviceType(position.DeviceType);

                                const address =
                                    type === DeviceType.Occupancy
                                        ? `/occupancy/${area.href?.split("/")[2]}`
                                        : position.href;

                                const device = createDevice(processor, areaWithPath, {
                                    ...position,
                                    Name: `${area.Name} ${control.Name} ${position.Name}`,
                                })
                                    .on("Update", this.onDeviceUpdate)
                                    .on("Action", this.onDeviceAction);

                                processor.devices.set(address, device);
                            }
                        }),
                    );

                    resolve();
                })
                .catch(() => resolve());
        });
    }

    /*
     * Discovers individual positions in a control station. Represents a single
     * keypad or remote in a gang.
     */
    private discoverPositions(processor: Processor, control: ControlStation): Promise<DeviceAddress[]> {
        return new Promise((resolve) => {
            if (control.AssociatedGangedDevices == null) return resolve([]);

            const waits: Promise<DeviceAddress>[] = [];

            for (const gangedDevice of control.AssociatedGangedDevices) {
                waits.push(processor.device(gangedDevice.Device));
            }

            // allSettled so one timed-out device does not drop the whole gang.
            Promise.allSettled(waits)
                .then((results) => {
                    const positions: DeviceAddress[] = [];

                    for (const result of results) {
                        if (result.status === "rejected") {
                            log.warn(
                                `control station ${control.Name || control.href}: device fetch failed: ${
                                    result.reason instanceof Error ? result.reason.message : String(result.reason)
                                }`,
                            );
                            continue;
                        }

                        if (isAddressable(result.value)) {
                            positions.push(result.value);
                        } else {
                            const value = result.value as DeviceAddress | null;
                            log.info(
                                `skipping non-addressable ${control.Name || "?"} ` +
                                    `type=${value?.DeviceType || typeof value} ` +
                                    `state=${value?.AddressedState || "?"} href=${value?.href || "?"}`,
                            );
                        }
                    }

                    resolve(positions);
                })
                .catch(() => resolve([]));
        });
    }

    /*
     * Creates a connection when mDNS finds a processor.
     */
    private onDiscovered = (host: ProcessorAddress): void => {
        this.discovered.delete(host.id);

        const addrs = (host.addresses || []).map((a) => `${a.family}:${a.address}`).join(", ");

        log.info(`Discovered host id=${host.id} type=${host.type} addresses=[${addrs}]`);

        if (!this.context.has(host.id)) {
            log.warn(
                `skipping host id=${host.id}: not in pairing (paired=[${this.context.processors.join(", ") || "none"}])`,
            );
            return;
        }

        const ip = host.addresses.find((address) => address.family === HostAddressFamily.IPv4) || host.addresses[0];

        if (ip == null) {
            log.error(`host id=${host.id} has no addresses`);
            return;
        }

        log.info(`connecting to processor id=${host.id} at ${ip.address}`);

        const processor = new ProcessorController(host.id, new Connection(ip.address, this.context.get(host.id)));

        this.discovered.set(host.id, processor);

        processor.log.info(`Processor ${Colors.green(ip.address)}`);

        processor
            .on("Disconnect", () => {
                log.warn(`processor ${host.id} disconnected; retry in ${RETRY_BACKOFF_DURATION}ms`);
                setTimeout(() => this.onDiscovered(host), RETRY_BACKOFF_DURATION);
            })
            .on("Connect", () => {
                log.info(`processor ${host.id} Connect event — loading system/project/areas (refresh=${this.refresh})`);

                if (this.refresh) processor.clear();

                // RESET RETRIES

                Promise.all([processor.system(), processor.project(), processor.areas()])
                    .then(([system, project, areas]) => {
                        const version = system?.FirmwareImage.Firmware.DisplayName;
                        const type = system?.DeviceType;
                        const waits: Promise<void>[] = [];

                        this.rebuildAreaPaths(areas);

                        log.info(
                            `processor ${host.id} system loaded firmware=${version || "Unknown"} type=${type} areas=${areas?.length ?? 0}`,
                        );

                        processor.log.info(`Firmware ${Colors.green(version || "Unknown")}`);
                        processor.log.info(project.ProductType);

                        processor
                            .subscribe<ZoneStatus[]>({ href: "/zone/status" }, (statuses: ZoneStatus[]): void => {
                                for (const status of statuses) {
                                    const device = processor.devices.get(status.Zone.href);

                                    if (device != null) device.update(status);
                                }
                            })
                            .then(() => log.info(`processor ${host.id} subscribed /zone/status`))
                            .catch((error) => this.onProcessorError(host, error));

                        processor
                            .subscribe<AreaStatus[]>({ href: "/area/status" }, (statuses: AreaStatus[]): void => {
                                for (const status of statuses) {
                                    const occupancy = processor.devices.get(`/occupancy/${status.href?.split("/")[2]}`);

                                    if (occupancy != null && status.OccupancyStatus != null) occupancy.update(status);
                                }
                            })
                            .then(() => log.info(`processor ${host.id} subscribed /area/status`))
                            .catch((error) => this.onProcessorError(host, error));

                        if (type === "RadioRa3Processor") {
                            processor
                                .subscribe<TimeclockStatus[]>(
                                    { href: "/timeclock/status" },
                                    (statuses: TimeclockStatus[]): void => {
                                        for (const status of statuses) {
                                            const device = processor.devices.get(
                                                (status as TimeclockStatus & { Timeclock: Address }).Timeclock.href,
                                            );

                                            if (device != null) device.update(status);
                                        }
                                    },
                                )
                                .then(() => log.info(`processor ${host.id} subscribed /timeclock/status`))
                                .catch((error) => this.onProcessorError(host, error));
                        }

                        for (const area of areas) {
                            waits.push(
                                new Promise((resolve) => {
                                    this.discoverZones(processor, area).then(() => resolve());
                                }),
                            );

                            waits.push(
                                new Promise((resolve) => {
                                    this.discoverControls(processor, area).then(() => resolve());
                                }),
                            );
                        }

                        if (type === "RadioRa3Processor") {
                            waits.push(
                                new Promise((resolve) => {
                                    this.discoverTimeclocks(processor).then(() => resolve());
                                }),
                            );
                        }

                        log.info(`processor ${host.id} discovering devices (${waits.length} wait tasks)`);

                        Promise.all(waits).then(async () => {
                            const devices = [...processor.devices.values()];

                            // Remotes/keypads load buttons asynchronously; wait so HomeKit
                            // accessories are built with StatelessProgrammableSwitch services.
                            await Promise.all(
                                devices.map(async (device) => {
                                    const ready = (device as Device & { ready?: Promise<void> }).ready;

                                    if (ready != null) {
                                        try {
                                            await ready;
                                        } catch (error) {
                                            log.warn(
                                                `device ${device.name} button init failed: ${
                                                    error instanceof Error ? error.message : String(error)
                                                }`,
                                            );
                                        }
                                    }
                                }),
                            );

                            const count = devices.length;

                            log.info(`processor ${host.id} discovery complete: ${count} devices; loading statuses`);

                            processor.statuses(type).then((statuses) => {
                                for (const status of statuses) {
                                    const zone = processor.devices.get(((status as ZoneStatus).Zone || {}).href || "");

                                    const occupancy = processor.devices.get(
                                        `/occupancy/${(status.href || "").split("/")[2]}`,
                                    );

                                    if (zone != null) zone.update(status as ZoneStatus);

                                    if (occupancy != null && (status as AreaStatus).OccupancyStatus != null) {
                                        occupancy.update(status as AreaStatus);
                                    }
                                }

                                log.info(`processor ${host.id} applied ${statuses.length} status record(s)`);
                            }).catch((error) => {
                                log.error(
                                    `processor ${host.id} statuses failed: ${error instanceof Error ? error.message : String(error)}`,
                                );
                            });

                            processor.log.info(
                                `discovered ${Colors.green(count.toString())} devices`,
                            );

                            // One-shot protocol inventory: area/group hierarchy + extra LEAP URLs.
                            probeProcessorMetadata(processor, areas).catch((error) => {
                                log.error(
                                    `metadata probe failed: ${error instanceof Error ? error.message : String(error)}`,
                                );
                            });

                            log.info(`processor ${host.id} emitting Available with ${count} devices`);
                            this.emit("Available", devices);
                        });
                    })
                    .catch((error) => this.onProcessorError(host, error));
            })
            .on("Error", (error: Error) => this.onProcessorError(host, error));

        processor.connect().catch((error) => this.onProcessorError(host, error));
    };

    /*
     * When a device updates, this will emit an update event.
     */
    private onDeviceUpdate = (device: Device, state: DeviceState): void => {
        this.emit("Update", device, state);
    };

    /*
     * When a control station emits an action, this will emit an action event.
     * This is when a button is pressed on a keypad or remote.
     */
    private onDeviceAction = (device: Device, button: Button, action: Action): void => {
        this.emit("Action", device, button, action);
    };

    private onProcessorError = (host: ProcessorAddress, error: Error): void => {
        const message = error?.message != null ? error.message : String(error);

        if (
            message.match(/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT/g) != null
        ) {
            log.warn(
                `processor ${host.id} network error: ${message}; retry in ${RETRY_BACKOFF_DURATION}ms`,
            );
            setTimeout(() => this.onDiscovered(host), RETRY_BACKOFF_DURATION);

            return;
        }

        log.error(Colors.red(`processor ${host.id} error: ${message}`));
    };
}
