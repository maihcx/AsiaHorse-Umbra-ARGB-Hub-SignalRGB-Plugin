/*
 * AsiaHorse Umbra / ROBOBLOQ USBFAN - SignalRGB plugin
 * USB VID: 0x1A86
 * USB PID: 0xFE05
 *
 * Native command:
 *   52 42 [length] 00 [body...] [checksum]
 *
 * Direct RGB packet:
 *   88 [packet count] [packet index] [20 x RGB] [checksum]
 *
 * Port topology query:
 *   Request body: 01 FF
 *   Response: 01 FF + 10 records x 5 bytes
 *
 * Observed record layout:
 *   [LED count] [unknown] [unknown] [port index] [unknown]
 *
 * Ports with no SignalRGB component configured are transmitted as black while
 * still reserving their controller-reported physical LED count in the Direct
 * RGB stream.
 *
 * No fixed per-port LED maximum is assumed. For populated ports, the
 * controller-reported LED count is used as the channel LedLimit. Empty ports
 * omit the optional limit because no grounded maximum is currently known.
 */

/* global debugLog */

export function Name() { return "AsiaHorse Umbra ARGB Hub"; }
export function VendorId() { return 0x1A86; }
export function ProductId() { return 0xFE05; }
export function Publisher() { return "Huynh Mai"; }
export function Documentation() { return "troubleshooting/other"; }
export function Type() { return "hid"; }
export function SubdeviceController() { return true; }

export function Size() { return [10, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 8.0; }

export function ImageUrl() {
    return "https://raw.githubusercontent.com/maihcx/AsiaHorse-Umbra-ARGB-Hub-SignalRGB-Plugin/main/Images/AsiaHorseUmbra.png";
}

export function ControllableParameters() {
    return [{
        property: "debugLog",
        group: "lighting",
        label: "Log protocol activity to console",
        type: "boolean",
        default: 0
    }];
}

const CHANNEL_COUNT = 10;
const CHANNEL_NAMES = Array.from(
    { length: CHANNEL_COUNT },
    (_, index) => `ARGB Port ${String(index + 1).padStart(2, "0")}`
);

const HID_REPORT_ID = 0x00;
const HID_PAYLOAD_SIZE = 64;
const HID_REPORT_SIZE = HID_PAYLOAD_SIZE + 1;

const NATIVE_HEADER_0 = 0x52;
const NATIVE_HEADER_1 = 0x42;

const DIRECT_RGB_HEADER = 0x88;
const DIRECT_RGB_LEDS_PER_PACKET = 20;

const PORT_QUERY = [0x01, 0xFF];
const PORT_RECORD_SIZE = 5;
const PORT_RECORDS_OFFSET = 6;
const PORT_QUERY_ATTEMPTS = 3;
const PORT_QUERY_RETRY_DELAY_MS = 20;

const INITIALIZATION_RETRY_INTERVAL_MS = 2000;
const DEBUG_FRAME_LOG_INTERVAL_MS = 5000;

/*
 * Observed startup command from the official application.
 * It appears to correspond to 100% brightness, but that semantic is not yet
 * considered fully confirmed, so the protocol name stays neutral here.
 */
const STARTUP_COMMAND_FB_64 = [0xFB, 0x64];

/* Observed command used before continuous software-driven RGB streaming. */
const SOFTWARE_CONTROL_COMMAND = [0xFD, 0x01];

let hubPorts = createEmptyPortTable();
let hubReady = false;
let channelsReady = false;
let softwareControlReady = false;

let retryCount = 0;
let nextRetryAt = 0;
let nextFrameDebugLogAt = 0;

export function Validate(endpoint) {
    return endpoint.interface === 0 &&
        endpoint.usage_page === 0xFF00 &&
        endpoint.usage === 0x0001;
}

export function LedNames() { return []; }
export function LedPositions() { return []; }

export function Initialize() {
    resetRetryState();
    removeLegacyChannels();
    attemptInitialization("startup");
}

export function Render() {
    if (!isReady()) {
        retryInitializationIfDue();
        return;
    }

    try {
        sendDirectRgbFrame();
    } catch (error) {
        scheduleFullRetry("Direct RGB transport failed", error);
    }
}

export function Shutdown(/* SystemSuspending */) {
    // Preserve the last visible lighting state.
}

export function ondebugLogChanged() {
    logTopology();
}

/* Hub initialization and topology */

function resetRuntimeState() {
    hubPorts = createEmptyPortTable();
    hubReady = false;
    channelsReady = false;
    softwareControlReady = false;
    nextFrameDebugLogAt = 0;
}

function resetRetryState() {
    retryCount = 0;
    nextRetryAt = 0;
}

function attemptInitialization(trigger) {
    resetRuntimeState();

    try {
        if (!loadHubTopology()) {
            scheduleRetry("hub topology could not be confirmed");
            return false;
        }

        if (!setupChannels()) {
            scheduleRetry("SignalRGB channels could not be confirmed");
            return false;
        }

        if (!enableSoftwareControl()) {
            scheduleRetry("software control could not be enabled");
            return false;
        }

        const completedRetryCount = retryCount;
        resetRetryState();

        if (isDebugLoggingEnabled() && trigger === "retry") {
            device.log(
                `[AsiaHorse] Retry succeeded after ${completedRetryCount} failed attempt(s).`
            );
        }

        logTopology();
        sendDirectRgbFrame();
        return true;
    } catch (error) {
        scheduleFullRetry("initialization exception", error);
        return false;
    }
}

function retryInitializationIfDue() {
    const now = Date.now();

    if (nextRetryAt !== 0 && now < nextRetryAt) {
        return;
    }

    attemptInitialization("retry");
}

function scheduleRetry(reason, error) {
    retryCount++;
    nextRetryAt = Date.now() + INITIALIZATION_RETRY_INTERVAL_MS;

    if (retryCount === 1 || isDebugLoggingEnabled()) {
        device.log(
            `[AsiaHorse] Not ready: ${reason}. Retrying in ` +
            `${INITIALIZATION_RETRY_INTERVAL_MS} ms.${formatErrorSuffix(error)}`
        );
    }
}

function scheduleFullRetry(reason, error) {
    resetRuntimeState();
    scheduleRetry(reason, error);
}

function loadHubTopology() {
    const ports = queryPortTopology();

    if (!ports) {
        return false;
    }

    hubPorts = ports;
    hubReady = true;
    return true;
}

function queryPortTopology() {
    for (let attempt = 0; attempt < PORT_QUERY_ATTEMPTS; attempt++) {
        try {
            clearReadBuffer();
            sendNativeCommand(PORT_QUERY);
            device.pause(2);

            const response = device.read(
                [HID_REPORT_ID],
                HID_REPORT_SIZE,
                100
            ) || [];

            const ports = parsePortTopology(response);
            if (ports) {
                return ports;
            }
        } catch (error) {
            if (isDebugLoggingEnabled()) {
                device.log(
                    `[AsiaHorse] Topology read attempt ${attempt + 1}/` +
                    `${PORT_QUERY_ATTEMPTS} failed.${formatErrorSuffix(error)}`
                );
            }
        }

        if (attempt + 1 < PORT_QUERY_ATTEMPTS) {
            device.pause(PORT_QUERY_RETRY_DELAY_MS);
        }
    }

    return null;
}

function parsePortTopology(data) {
    const packetStart = findNativeResponse(data, PORT_QUERY);
    if (packetStart < 0) {
        return null;
    }

    const recordsStart = packetStart + PORT_RECORDS_OFFSET;
    const recordsEnd = recordsStart + CHANNEL_COUNT * PORT_RECORD_SIZE;

    if (recordsEnd > data.length) {
        return null;
    }

    const ports = new Array(CHANNEL_COUNT).fill(null);

    for (let record = 0; record < CHANNEL_COUNT; record++) {
        const offset = recordsStart + record * PORT_RECORD_SIZE;
        const port = {
            ledCount: clampByte(data[offset]),
            field1: clampByte(data[offset + 1]),
            field2: clampByte(data[offset + 2]),
            index: clampByte(data[offset + 3]),
            field4: clampByte(data[offset + 4])
        };

        if (port.index >= CHANNEL_COUNT || ports[port.index] !== null) {
            return null;
        }

        ports[port.index] = port;
    }

    return ports.every(port => port !== null) ? ports : null;
}

/* SignalRGB channel setup */

function setupChannels() {
    if (!hubReady) {
        return false;
    }

    /*
     * This is the controller's currently detected physical LED capacity, not a
     * claimed hardware maximum. It keeps SignalRGB's aggregate limit aligned
     * with the topology we can actually address in the current Direct RGB
     * stream.
     */
    device.SetLedLimit(getTotalLedCount());

    for (let portIndex = 0; portIndex < CHANNEL_COUNT; portIndex++) {
        const name = CHANNEL_NAMES[portIndex];

        /*
         * Do not remove and recreate current channels during normal startup.
         * Existing channels can carry the user's configured components and
         * SignalRGB already cleans channels up on a normal shutdown.
         */
        if (device.channel(name)) {
            continue;
        }

        const detectedPortLedCount = hubPorts[portIndex].ledCount;

        if (detectedPortLedCount > 0) {
            device.addChannel(name, detectedPortLedCount);
        } else {
            device.addChannel(name);
        }
    }

    channelsReady = CHANNEL_NAMES.every(name => Boolean(device.channel(name)));
    return channelsReady;
}

function removeLegacyChannels() {
    for (let index = 0; index < CHANNEL_COUNT; index++) {
        const legacyName = `ARGB Port ${index + 1}`;
        const currentName = CHANNEL_NAMES[index];

        if (legacyName !== currentName) {
            removeChannelIfPresent(legacyName);
        }
    }
}

function removeChannelIfPresent(name) {
    try {
        if (device.channel(name)) {
            device.removeChannel(name);
        }
    } catch (error) {
        // Ignore missing or stale development channels.
    }
}

function enableSoftwareControl() {
    if (!hubReady || !channelsReady) {
        return false;
    }

    sendNativeCommand(STARTUP_COMMAND_FB_64);
    device.pause(10);

    sendNativeCommand(SOFTWARE_CONTROL_COMMAND);
    device.pause(2);

    softwareControlReady = true;
    return true;
}

function isReady() {
    return hubReady && channelsReady && softwareControlReady;
}

/* Direct RGB rendering */

function sendDirectRgbFrame() {
    if (!isReady()) {
        return;
    }

    const totalLedCount = getTotalLedCount();
    if (totalLedCount <= 0) {
        return;
    }

    const packetCount = Math.ceil(totalLedCount / DIRECT_RGB_LEDS_PER_PACKET);
    const frameSlotCount = packetCount * DIRECT_RGB_LEDS_PER_PACKET;
    const frame = buildFrame(frameSlotCount);

    for (let packet = 0; packet < packetCount; packet++) {
        const start = packet * DIRECT_RGB_LEDS_PER_PACKET;

        sendDirectRgbPacket(
            packetCount,
            packet + 1,
            frame.slice(start, start + DIRECT_RGB_LEDS_PER_PACKET)
        );
    }

    logDirectRgbFrameIfDue(totalLedCount, packetCount);
}

function buildFrame(frameSlotCount) {
    const frame = [];

    for (let portIndex = 0; portIndex < CHANNEL_COUNT; portIndex++) {
        const physicalLedCount = hubPorts[portIndex].ledCount;
        if (physicalLedCount <= 0) {
            continue;
        }

        appendColors(frame, getPortColors(portIndex, physicalLedCount));
    }

    appendBlack(frame, frameSlotCount - frame.length);
    return frame;
}

function getPortColors(portIndex, physicalLedCount) {
    const channel = device.channel(CHANNEL_NAMES[portIndex]);
    if (!channel) {
        return blackColors(physicalLedCount);
    }

    const sourceLedCount = channel.LedCount();
    if (sourceLedCount <= 0) {
        return blackColors(physicalLedCount);
    }

    return resampleChannel(channel, sourceLedCount, physicalLedCount);
}

function resampleChannel(channel, sourceLedCount, targetLedCount) {
    const colorData = channel.getColors("Seperate");
    if (!colorData || colorData.length < 3) {
        return blackColors(targetLedCount);
    }

    const red = colorData[0] || [];
    const green = colorData[1] || [];
    const blue = colorData[2] || [];

    const availableSourceCount = Math.min(
        sourceLedCount,
        red.length,
        green.length,
        blue.length
    );

    if (availableSourceCount <= 0) {
        return blackColors(targetLedCount);
    }

    const colors = new Array(targetLedCount);

    for (let target = 0; target < targetLedCount; target++) {
        const source = mapSampleIndex(
            target,
            targetLedCount,
            availableSourceCount
        );

        colors[target] = [
            clampByte(red[source]),
            clampByte(green[source]),
            clampByte(blue[source])
        ];
    }

    return colors;
}

function mapSampleIndex(targetIndex, targetCount, sourceCount) {
    if (targetCount <= 1 || sourceCount <= 1) {
        return 0;
    }

    return Math.round(
        (targetIndex / (targetCount - 1)) * (sourceCount - 1)
    );
}

function sendDirectRgbPacket(packetCount, packetIndex, colors) {
    const packet = [
        DIRECT_RGB_HEADER,
        packetCount & 0xFF,
        packetIndex & 0xFF
    ];

    for (let led = 0; led < DIRECT_RGB_LEDS_PER_PACKET; led++) {
        const color = colors[led] || [0, 0, 0];

        packet.push(
            clampByte(color[0]),
            clampByte(color[1]),
            clampByte(color[2])
        );
    }

    packet.push(checksum(packet));
    writeHidPayload(packet);
}

function logDirectRgbFrameIfDue(totalLedCount, packetCount) {
    if (!isDebugLoggingEnabled()) {
        return;
    }

    const now = Date.now();
    if (now < nextFrameDebugLogAt) {
        return;
    }

    nextFrameDebugLogAt = now + DEBUG_FRAME_LOG_INTERVAL_MS;

    device.log(
        `[AsiaHorse] Direct RGB: LEDs=${totalLedCount} ` +
        `packets=${packetCount} layout=[${getLedCounts().join(",")}]`
    );
}

/* Native transport */

function sendNativeCommand(body) {
    const packet = [
        NATIVE_HEADER_0,
        NATIVE_HEADER_1,
        (body.length + 5) & 0xFF,
        0x00
    ];

    for (const byte of body) {
        packet.push(clampByte(byte));
    }

    packet.push(checksum(packet));
    writeHidPayload(packet);
}

function writeHidPayload(payload) {
    if (!payload || payload.length > HID_PAYLOAD_SIZE) {
        throw new Error(`HID payload exceeds ${HID_PAYLOAD_SIZE} bytes.`);
    }

    const report = new Array(HID_REPORT_SIZE).fill(0);
    report[0] = HID_REPORT_ID;

    for (let index = 0; index < payload.length; index++) {
        report[index + 1] = clampByte(payload[index]);
    }

    device.write(report, HID_REPORT_SIZE);
}

function clearReadBuffer() {
    try {
        if (device.clearReadBuffer) {
            device.clearReadBuffer();
        }
    } catch (error) {
        // Some runtimes or endpoints may not expose a readable buffer here.
    }
}

/* Topology helpers */

function getTotalLedCount() {
    return hubPorts.reduce((total, port) => total + port.ledCount, 0);
}

function getLedCounts() {
    return hubPorts.map(port => port.ledCount);
}

function createEmptyPortTable() {
    return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
        ledCount: 0,
        field1: 0,
        field2: 0,
        index,
        field4: 0
    }));
}

function logTopology() {
    if (!isDebugLoggingEnabled() || !hubReady) {
        return;
    }

    device.log(
        `[AsiaHorse] Topology: LEDs=[${getLedCounts().join(",")}] ` +
        `total=${getTotalLedCount()}`
    );

    for (const port of hubPorts) {
        device.log(
            `[AsiaHorse] Port ${String(port.index + 1).padStart(2, "0")}: ` +
            `LEDs=${port.ledCount} field1=${port.field1} ` +
            `field2=${port.field2} field4=${port.field4}`
        );
    }
}

/* Generic helpers */

function blackColors(count) {
    return Array.from(
        { length: Math.max(0, count) },
        () => [0, 0, 0]
    );
}

function appendBlack(target, count) {
    for (let index = 0; index < count; index++) {
        target.push([0, 0, 0]);
    }
}

function appendColors(target, colors) {
    for (const color of colors) {
        target.push(color);
    }
}

function findNativeResponse(data, command) {
    if (!data || !command || command.length < 2) {
        return -1;
    }

    for (let start = 0; start + 5 < data.length; start++) {
        if (
            data[start] === NATIVE_HEADER_0 &&
            data[start + 1] === NATIVE_HEADER_1 &&
            data[start + 4] === command[0] &&
            data[start + 5] === command[1]
        ) {
            return start;
        }
    }

    return -1;
}

function checksum(bytes) {
    let sum = 0;

    for (const byte of bytes) {
        sum = (sum + (byte & 0xFF)) & 0xFF;
    }

    return sum;
}

function clampByte(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.max(0, Math.min(255, Math.round(number)));
}

function formatErrorSuffix(error) {
    if (!error) {
        return "";
    }

    try {
        const message = error.message || String(error);
        return message ? ` Error: ${message}` : "";
    } catch (formatError) {
        return "";
    }
}

function isDebugLoggingEnabled() {
    if (typeof debugLog === "undefined") {
        return false;
    }

    return debugLog === true ||
        debugLog === 1 ||
        debugLog === "1" ||
        debugLog === "true";
}
