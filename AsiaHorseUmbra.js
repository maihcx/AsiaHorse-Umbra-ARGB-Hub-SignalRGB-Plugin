/*
 * AsiaHorse Umbra / ROBOBLOQ USBFAN - SignalRGB plugin
 * USB VID: 0x1A86
 * USB PID: 0xFE05
 *
 * FE05 protocol implementation based on a USBPcap capture from the
 * official AsiaHorse software.
 *
 * Important:
 * - The physical controller has 10 ARGB ports.
 * - The supplied capture only exercised 8 connected ports, so indexes 0..7
 *   are confirmed from traffic; indexes 8..9 are mapped by the same protocol
 *   convention and should correspond to physical ports 9 and 10.
 * - The captured FE05 command configures a native per-port color profile,
 *   not individual LED pixels. Therefore SignalRGB colors are reduced to
 *   one representative color per physical ARGB port.
 */

export function Name() { return "AsiaHorse Umbra ARGB Hub"; }
export function VendorId() { return 0x1A86; }
export function ProductId() { return 0xFE05; }
export function Publisher() { return "Huynh Mai"; }
export function Documentation() { return "troubleshooting/other"; }
export function Type() { return "hid"; }
export function SubdeviceController() { return true; }

export function Size() { return [8, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 8.0; }
export function ImageUrl() { return "https://raw.githubusercontent.com/maihcx/AsiaHorse-Umbra-ARGB-Hub-SignalRGB-Plugin/main/Images/AsiaHorseUmbra.png"; }

export function ControllableParameters() {
    return [];
}

const CHANNEL_COUNT = 10;
const LED_LIMIT_PER_CHANNEL = 120;
const DEVICE_LED_LIMIT = CHANNEL_COUNT * LED_LIMIT_PER_CHANNEL;

const CHANNELS = [
    "ARGB Port 01",
    "ARGB Port 02",
    "ARGB Port 03",
    "ARGB Port 04",
    "ARGB Port 05",
    "ARGB Port 06",
    "ARGB Port 07",
    "ARGB Port 08",
    "ARGB Port 09",
    "ARGB Port 10"
];

// Exact native FE05 static/custom-color profile bytes observed in the capture.
// Bytes 23..58 are twelve RGB palette entries.
const PORT_PROFILE_PREFIX = [
    0x03, 0xFD, // command family
    0x00,       // physical port index, replaced before sending
    0x04,
    0x01, 0x01, 0x01, 0x01, 0x01,
    0x00,       // custom/static color selection observed in the capture
    0x03, 0x03, 0x03,
    0x01, 0x01, 0x01,
    0x99, 0x99, 0x99
];

let frameCounter = 0;
let lastColors = [];
let portInitialized = [];

export function Validate(endpoint) {
    return endpoint.interface === 0 &&
           endpoint.usage_page === 0xFF00 &&
           endpoint.usage === 0x0001;
}

export function LedNames() {
    return [];
}

export function LedPositions() {
    return [];
}

export function Initialize() {
    setupChannels();

    lastColors = [];
    portInitialized = [];
    frameCounter = 0;

    // Startup sequence observed from the official software.
    // 0xFB 0x64 = controller brightness 100%.
    // 0xFD 0x01 = enable the independently controlled lighting mode.
    sendNativeCommand([0xFB, 0x64]);
    device.pause(10);
    sendNativeCommand([0xFD, 0x01]);
    device.pause(10);

    // Push an initial frame immediately for every configured channel.
    renderPorts(true);
}

export function Render() {
    // The official application sends 52 42 06 00 00 9A roughly once per second.
    // SignalRGB normally renders around every 30 ms, so 30 frames is close enough.
    frameCounter++;

    if ((frameCounter % 30) === 0) {
        sendKeepAlive();
    }

    renderPorts(false);
}

export function Shutdown(/* SystemSuspending */) {
    // Preserve the last visible lighting state.
}

function setupChannels() {
    device.SetLedLimit(DEVICE_LED_LIMIT);

    // Remove channels left behind by hot-reloading older plugin versions.
    for (let i = 1; i <= CHANNEL_COUNT; i++) {
        const oldName = "ARGB Port " + i;
        const newName = "ARGB Port " + String(i).padStart(2, "0");

        try {
            device.removeChannel(oldName);
        } catch (e) {
            // Ignore channels that do not exist.
        }

        try {
            device.removeChannel(newName);
        } catch (e) {
            // Ignore channels that do not exist.
        }
    }

    for (let i = 0; i < CHANNEL_COUNT; i++) {
        device.addChannel(CHANNELS[i], LED_LIMIT_PER_CHANNEL);
    }
}

function renderPorts(force) {
    for (let port = 0; port < CHANNEL_COUNT; port++) {
        const channel = device.channel(CHANNELS[port]);

        if (!channel) {
            continue;
        }

        const ledCount = channel.LedCount();

        // Leave unconfigured physical outputs untouched.
        if (ledCount <= 0) {
            continue;
        }

        const rgb = getRepresentativeColor(channel, ledCount);

        if (!force && portInitialized[port] && colorsEqual(lastColors[port], rgb)) {
            continue;
        }

        sendPortColor(port, rgb);

        lastColors[port] = [rgb[0], rgb[1], rgb[2]];
        portInitialized[port] = true;
    }
}

function getRepresentativeColor(channel, ledCount) {
    const colorData = channel.getColors("Seperate");

    if (!colorData || colorData.length < 3) {
        return [0, 0, 0];
    }

    const red = colorData[0] || [];
    const green = colorData[1] || [];
    const blue = colorData[2] || [];

    const count = Math.min(
        ledCount,
        red.length,
        green.length,
        blue.length
    );

    if (count <= 0) {
        return [0, 0, 0];
    }

    // Root-mean-square averaging preserves saturated animated colors better
    // than a simple arithmetic average, which tends to turn rainbow effects
    // into dull grey/white.
    let r2 = 0;
    let g2 = 0;
    let b2 = 0;

    for (let i = 0; i < count; i++) {
        const r = clampByte(red[i]);
        const g = clampByte(green[i]);
        const b = clampByte(blue[i]);

        r2 += r * r;
        g2 += g * g;
        b2 += b * b;
    }

    return [
        clampByte(Math.sqrt(r2 / count)),
        clampByte(Math.sqrt(g2 / count)),
        clampByte(Math.sqrt(b2 / count))
    ];
}

function sendPortColor(port, rgb) {
    const body = PORT_PROFILE_PREFIX.slice();

    // Body index 2 corresponds to packet byte 6 in the captured 64-byte report.
    body[2] = port & 0xFF;

    // The official software repeats the selected solid color across all
    // twelve palette slots. Reproduce that exact behavior.
    for (let i = 0; i < 12; i++) {
        body.push(rgb[0] & 0xFF);
        body.push(rgb[1] & 0xFF);
        body.push(rgb[2] & 0xFF);
    }

    sendNativeCommand(body);
}

function sendKeepAlive() {
    sendNativeCommand([0x00]);
}

function sendNativeCommand(body) {
    // Captured FE05 framing:
    //   52 42 [logical length] 00 [body...] [8-bit additive checksum]
    //
    // The logical length includes every meaningful byte, including checksum.
    // The HID payload is then padded to exactly 64 bytes.
    const packet = [0x52, 0x42, 0x00, 0x00];

    for (let i = 0; i < body.length; i++) {
        packet.push(body[i] & 0xFF);
    }

    packet[2] = (packet.length + 1) & 0xFF;
    packet.push(checksum(packet));

    while (packet.length < 64) {
        packet.push(0x00);
    }

    // SignalRGB HID writes include report ID 0 as byte 0.
    const report = [0x00];

    for (let i = 0; i < 64; i++) {
        report.push(packet[i] & 0xFF);
    }

    device.write(report, 65);
}

function checksum(bytes) {
    let sum = 0;

    for (let i = 0; i < bytes.length; i++) {
        sum = (sum + (bytes[i] & 0xFF)) & 0xFF;
    }

    return sum;
}

function colorsEqual(a, b) {
    return a &&
           b &&
           a[0] === b[0] &&
           a[1] === b[1] &&
           a[2] === b[2];
}

function clampByte(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.max(0, Math.min(255, Math.round(number)));
}
