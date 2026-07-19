import { Device } from "@mkellsy/hap-device";

import { AreaAddress } from "../Response/AreaAddress";
import { Processor } from "../Devices/Processor/Processor";

// Use console so Homebridge child-bridge logs capture this even if js-logger
// is not wired (esbuild can isolate logger instances).
const log = {
    info: (message: string) => console.log(`[LEAP][MetaProbe] ${message}`),
    warn: (message: string) => console.warn(`[LEAP][MetaProbe] ${message}`),
};

/**
 * Candidate LEAP URLs that may expose grouping / catalog metadata.
 * Many will 404 or reject; that is expected and still useful signal.
 */
const PROBE_URLS: string[] = [
    "/area",
    "/zone",
    "/device",
    "/controlstation",
    "/occupancygroup",
    "/group",
    "/areagroup",
    "/zonegroup",
    "/loadgroup",
    "/devicegroup",
    "/virtualbutton",
    "/preset",
    "/area/status",
    "/zone/status",
    "/server/1/status/ping",
    "/project",
    "/clientsetting",
    "/link",
    "/button",
    "/buttongroup",
    "/timeclock",
];

function summarizeBody(body: unknown): string {
    if (body == null) return "null";

    if (Array.isArray(body)) {
        const first = body[0] as Record<string, unknown> | undefined;
        const keys = first != null && typeof first === "object" ? Object.keys(first).join(",") : "";

        return `array(len=${body.length}${keys ? ` sampleKeys=${keys}` : ""})`;
    }

    if (typeof body === "object") {
        const record = body as Record<string, unknown>;
        const keys = Object.keys(record);

        return `object(keys=${keys.slice(0, 20).join(",")}${keys.length > 20 ? ",..." : ""})`;
    }

    if (typeof body === "string") {
        return `string(len=${body.length} preview=${JSON.stringify(body.slice(0, 200))})`;
    }

    return `${typeof body}:${String(body).slice(0, 120)}`;
}

function areaPath(areas: AreaAddress[], href: string | undefined): string {
    if (href == null) return "";

    const byHref = new Map(areas.map((a) => [a.href, a]));
    const names: string[] = [];
    let current: string | undefined = href;
    const seen = new Set<string>();

    while (current != null && !seen.has(current)) {
        seen.add(current);
        const area = byHref.get(current);

        if (area == null) break;

        names.unshift(area.Name);
        current = area.Parent?.href;
    }

    return names.join(" / ");
}

/**
 * Live LEAP metadata probe: dumps area hierarchy, zone/device associations,
 * and tries extra endpoints that might correspond to "groups" in other apps.
 * @private
 */
export async function probeProcessorMetadata(processor: Processor, areas: AreaAddress[]): Promise<void> {
    log.info(`===== LEAP metadata probe start processor=${processor.id} areas=${areas.length} =====`);

    // Area tree (rooms / floors). UniFi Connect "groups" often map to this.
    for (const area of areas) {
        log.info(
            `AREA href=${area.href} name=${JSON.stringify(area.Name)} leaf=${area.IsLeaf} ` +
                `parent=${area.Parent?.href || "none"} path=${JSON.stringify(areaPath(areas, area.href))} ` +
                `keys=${Object.keys(area).join(",")}`,
        );
    }

    // Zones + control stations already fetched for leaf areas (cache-backed).
    for (const area of areas.filter((a) => a.IsLeaf)) {
        const path = areaPath(areas, area.href);

        try {
            const zones = await processor.zones(area);

            for (const zone of zones) {
                log.info(
                    `ZONE area=${JSON.stringify(path)} name=${JSON.stringify(zone.Name)} ` +
                        `href=${zone.href} control=${zone.ControlType} ` +
                        `category=${zone.Category?.Type || ""} isLight=${zone.Category?.IsLight ?? "?"} ` +
                        `assocArea=${zone.AssociatedArea?.href || ""} ` +
                        `device=${zone.Device?.href || ""} keys=${Object.keys(zone).join(",")}`,
                );
            }
        } catch (error) {
            log.warn(`ZONE list failed for ${area.href}: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            const stations = await processor.controls(area);

            for (const station of stations) {
                const ganged = (station.AssociatedGangedDevices || [])
                    .map((g) => `${g.Device?.DeviceType || "?"}@${g.Device?.href || "?"}`)
                    .join(",");

                log.info(
                    `STATION area=${JSON.stringify(path)} name=${JSON.stringify(station.Name)} ` +
                        `href=${station.href} ganged=[${ganged}] keys=${Object.keys(station).join(",")}`,
                );
            }
        } catch (error) {
            log.warn(`STATION list failed for ${area.href}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Live raw reads of candidate catalog endpoints (bypass high-level helpers).
    for (const url of PROBE_URLS) {
        try {
            const body = await processor.read(url);

            log.info(`PROBE ok url=${url} body=${summarizeBody(body)}`);

            // For small arrays/objects, dump a compact JSON sample.
            if (Array.isArray(body) && body.length > 0 && body.length <= 5) {
                log.info(`PROBE sample url=${url} ${JSON.stringify(body).slice(0, 1500)}`);
            } else if (Array.isArray(body) && body.length > 5) {
                log.info(`PROBE sample url=${url} first=${JSON.stringify(body[0]).slice(0, 800)}`);
            } else if (body != null && typeof body === "object" && !Array.isArray(body)) {
                log.info(`PROBE sample url=${url} ${JSON.stringify(body).slice(0, 1200)}`);
            }
        } catch (error) {
            log.info(`PROBE fail url=${url}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Devices currently discovered by the client with room metadata.
    for (const device of processor.devices.values()) {
        const area = device.area as AreaAddress | undefined;
        const withPath = device as Device & { areaPath?: string };
        const path = typeof withPath.areaPath === "string" ? withPath.areaPath : areaPath(areas, area?.href);

        log.info(
            `DEVICE type=${device.type} name=${JSON.stringify(device.name)} room=${JSON.stringify(device.room)} ` +
                `areaPath=${JSON.stringify(path)} id=${device.id} href=${device.address?.href || ""} ` +
                `areaHref=${area?.href || ""} areaParent=${area?.Parent?.href || ""}`,
        );
    }

    log.info(`===== LEAP metadata probe done processor=${processor.id} =====`);
}
