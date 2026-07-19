import os from "os";
import path from "path";
import equals from "deep-equal";

import Cache from "flat-cache";
import { get as getLogger } from "js-logger";

import { EventEmitter } from "@mkellsy/event-emitter";
import { MDNSService, MDNSServiceDiscovery, Protocol } from "tinkerhub-mdns";
import { HostAddress, HostAddressFamily } from "@mkellsy/hap-device";

import { ProcessorAddress } from "../Response/ProcessorAddress";

const log = getLogger("Discovery");

/**
 * Creates and searches the network for devices.
 * @private
 */
export class Discovery extends EventEmitter<{
    Discovered: (processor: ProcessorAddress) => void;
    Failed: (error: Error) => void;
}> {
    private cache: Cache.Cache;
    private cached: ProcessorAddress[];
    private discovery?: MDNSServiceDiscovery;

    /**
     * Creates a mDNS discovery object used to search the network for devices.
     *
     * ```js
     * const discovery = new Discovery();
     *
     * discovery.on("Discovered", (device: ProcessorAddress) => {  });
     * discovery.search()
     * ```
     */
    constructor() {
        super();

        this.cache = Cache.load("discovery", path.join(os.homedir(), ".leap"));
        this.cached = this.cache.getKey("/hosts") || [];

        this.cache.setKey("/hosts", this.cached);
        this.cache.save(true);
    }

    /**
     * Starts searching the network for devices.
     */
    public search(): void {
        this.stop();

        log.info(`search start: ${this.cached.length} cached host(s)`);

        for (let i = 0; i < this.cached.length; i++) {
            const host = this.cached[i];
            const addrs = (host.addresses || []).map((a) => a.address).join(",");

            log.info(`emit cached host id=${host.id} type=${host.type} addresses=[${addrs}]`);
            this.emit("Discovered", host);
        }

        this.discovery = new MDNSServiceDiscovery({ type: "lutron", protocol: Protocol.TCP });
        this.discovery.onAvailable(this.onAvailable);
        log.info("mDNS browse started for _lutron._tcp");
    }

    /**
     * Stops searching the network.
     */
    public stop(): void {
        this.discovery?.destroy();
    }

    /*
     * Parses a service once discovered. If it fits the criteria, this will
     * emit a discovered event.
     */
    private onAvailable = (service: MDNSService): void => {
        const systype = service.data.get("systype");

        if (!this.isProcessorService(service)) {
            log.debug(`mDNS ignore service id=${service.id} systype=${String(systype)}`);
            return;
        }

        let host: ProcessorAddress;

        try {
            host = this.parseProcessorAddress(service);
        } catch (error) {
            log.error(
                `mDNS parse failed for service id=${service.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }

        const addrs = (host.addresses || []).map((a) => a.address).join(",");
        const cached = this.isProcessorCached(host);

        log.info(`mDNS processor id=${host.id} type=${host.type} addresses=[${addrs}] cached=${cached}`);

        if (!cached) this.emit("Discovered", host);

        this.cacheProcessor(host);
    };

    /*
     * Determines if a processor host is currently cached.
     */
    private isProcessorCached(host: ProcessorAddress): boolean {
        return this.cached.find((entry) => equals(entry, host)) != null;
    }

    /*
     * Determines if a MDNS service is a processor.
     */
    private isProcessorService(service: MDNSService): boolean {
        const type = service.data.get("systype");

        if (type == null || typeof type === "boolean") return false;

        return true;
    }

    /*
     * Saves a processor host to disk cache.
     */
    private cacheProcessor(host: ProcessorAddress): void {
        const index = this.cached.findIndex((entry) => entry.id === host.id);

        if (index >= 0) {
            this.cached[index] = host;
        } else {
            this.cached.push(host);
        }

        this.cache.setKey("/hosts", this.cached);
        this.cache.save();
    }

    /*
     * Transforms a MDNS service to a processor host.
     */
    private parseProcessorAddress(service: MDNSService): ProcessorAddress {
        const target = (this.discovery as any).serviceData.get(service.id).SRV._record.target;
        const addresses: HostAddress[] = [];

        for (let i = 0; i < service.addresses?.length; i++) {
            addresses.push({
                address: service.addresses[i].host,
                family: /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i.test(service.addresses[i].host)
                    ? HostAddressFamily.IPv6
                    : HostAddressFamily.IPv4,
            });
        }

        return {
            id: target.match(/[Ll]utron-(?<id>\w+)\.local/)!.groups!.id.toUpperCase(),
            type: String(service.data.get("systype")),
            addresses,
        };
    }
}
