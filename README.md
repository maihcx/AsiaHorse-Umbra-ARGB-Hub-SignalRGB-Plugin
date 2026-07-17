# AsiaHorse Umbra ARGB Hub - SignalRGB Plugin

*[Vietnamese version below](#phiên-bản-tiếng-việt)*

A custom SignalRGB plugin for the **AsiaHorse Umbra ARGB Hub / ROBOBLOQ USBFAN controller**.

The plugin communicates directly with the controller over USB HID and provides independent SignalRGB channels for its physical ARGB ports.

**USB VID:** `0x1A86`  
**USB PID:** `0xFE05`

## Features

- Direct USB HID communication with the AsiaHorse Umbra controller
- 10 independent ARGB channels in SignalRGB
- Automatic controller topology detection
- Automatic per-port LED count detection
- Dynamic Direct RGB frame sizing
- Automatic color resampling when a configured SignalRGB component uses a different LED count
- Software control mode initialization
- Automatic initialization retry if the controller is not ready
- Optional protocol and topology debug logging
- No requirement for the official AsiaHorse software while SignalRGB is controlling the hub

## SignalRGB Channels

The plugin exposes the controller as 10 independent channels:

```text
ARGB Port 01
ARGB Port 02
ARGB Port 03
ARGB Port 04
ARGB Port 05
ARGB Port 06
ARGB Port 07
ARGB Port 08
ARGB Port 09
ARGB Port 10
```

The plugin does not automatically assign a SignalRGB component to a channel. Components can be configured from SignalRGB as needed.

For a populated port, the LED count reported by the controller is used as that channel's LED limit.

For a port reported as empty, the channel is still exposed in SignalRGB, but no fixed LED limit is assumed.

## Automatic Port Topology Detection

During initialization, the plugin queries the controller using the native command body:

```text
01 FF
```

The observed topology response contains 10 records, one for each physical port.

The currently observed record layout is:

```text
[LED Count] [Unknown] [Unknown] [Port Index] [Unknown]
```

The plugin uses:

- `LED Count` to determine the physical number of LEDs currently reported for the port
- `Port Index` to place the record into the correct physical port

The remaining fields are preserved for debugging but are not currently used for rendering.

The controller-wide SignalRGB LED limit is calculated from the sum of all detected physical LED counts.

## Direct RGB Streaming

Live SignalRGB effects are sent using the controller's Direct RGB protocol:

```text
88 [Packet Count] [Packet Index] [20 x RGB] [Checksum]
```

Each Direct RGB packet contains 20 RGB values.

The number of packets is calculated dynamically:

```text
Packet Count = ceil(Total Detected LEDs / 20)
```

The RGB stream is assembled in physical port order:

```text
ARGB Port 01
ARGB Port 02
ARGB Port 03
...
ARGB Port 10
```

Each populated port reserves exactly the number of RGB entries reported by the controller.

Ports reported with `0` LEDs do not reserve entries in the Direct RGB stream.

The final packet is padded with black RGB values when the total LED count is not an exact multiple of 20.

### Example

If the controller reports:

```text
Port 01 = 14 LEDs
Port 02 = 14 LEDs
Port 03 = 14 LEDs
Port 04 = 0 LEDs
Port 05 = 14 LEDs
```

the Direct RGB stream contains:

```text
14 + 14 + 14 + 14 = 56 physical LED entries
```

The plugin therefore sends:

```text
ceil(56 / 20) = 3 packets
```

The frame contains 60 RGB slots in total:

```text
56 physical LED entries
4 black padding entries
```

## Component Color Mapping

The physical LED count comes from the controller topology, while the configured SignalRGB component provides the source colors.

If both counts match, colors map directly.

If the configured component provides a different number of LEDs, the plugin resamples the component colors across the controller-reported physical LED count.

For example:

```text
SignalRGB component: 10 LEDs
Controller-reported port: 14 LEDs
```

The 10 source colors are resampled across the 14 physical LED positions.

If no component is configured for a populated port, the plugin still reserves that port's physical LED positions in the Direct RGB stream and sends them as black. This prevents later ports from shifting to incorrect positions in the stream.

## Controller Initialization

After successfully reading the topology and creating the SignalRGB channels, the plugin sends:

```text
FB 64
```

followed by:

```text
FD 01
```

`FD 01` is used to enter software-controlled RGB streaming mode.

The exact semantics of `FB 64` are not considered fully confirmed, so the plugin treats it as an observed startup command rather than assigning an undocumented protocol meaning to it.

If initialization fails, the plugin retries automatically at a fixed interval.

## Native Command Format

Native controller commands use the following framing:

```text
52 42 [Length] 00 [Command Data...] [Checksum]
```

Commands are written as a 64-byte HID payload using HID Report ID `0`.

The checksum is an 8-bit additive checksum:

```text
sum(all packet bytes before checksum) & 0xFF
```

## Direct RGB Packet Format

Each Direct RGB packet has the following structure:

```text
Byte 0     = 0x88
Byte 1     = total packet count
Byte 2     = 1-based packet index
Byte 3..62 = 20 RGB values
Byte 63    = additive checksum
```

The packet checksum is calculated as:

```text
sum(all packet bytes before checksum) & 0xFF
```

## Debug Logging

The plugin provides the following controllable parameter:

```text
Log protocol activity to console
```

When enabled, the plugin logs information such as:

- Detected LED count for each physical port
- Total detected LED count
- Additional unknown topology record fields
- Direct RGB packet count
- Current physical LED layout
- Initialization retry information
- Transport or topology read errors

Periodic Direct RGB status logging is rate-limited to avoid excessive console output.

## Installation

1. Download `AsiaHorseUmbra.js`.

2. Open a SignalRGB plugin directory, such as:

```text
Documents\WhirlwindFX\Plugins
```

or:

```text
Documents\SignalRGB\Plugins
```

3. Copy `AsiaHorseUmbra.js` into the plugin directory.

4. Completely close the official AsiaHorse RGB software, including any process still running in the System Tray.

5. Restart SignalRGB or reload the plugin.

6. The controller should appear as:

```text
AsiaHorse Umbra ARGB Hub
```

7. Configure the desired SignalRGB component on each ARGB channel that has a connected device.

## Important Notes and Limitations

### Official AsiaHorse software

Do not run the official AsiaHorse RGB software and SignalRGB control at the same time. Both applications may attempt to communicate with the same USB HID controller.

### Topology is detected during initialization

The plugin reads the controller's port topology during initialization.

If the physical devices connected to the hub are changed while the plugin is already running, reload the plugin or restart SignalRGB so the topology and physical LED counts can be detected again.

### Controller-reported LED counts

The plugin relies on the LED counts returned by the controller.

For populated ports, these values determine:

- The channel LED limit
- The physical RGB allocation in the Direct RGB stream
- The total number of Direct RGB packets

The plugin does not assume a fixed LED count or fixed maximum for every port.

### Empty ports

Ports reported with `0` LEDs remain visible as SignalRGB channels but contribute no RGB entries to the physical Direct RGB stream.

### Other AsiaHorse controllers

Compatibility with other AsiaHorse RGB controllers has not been verified.

Controllers using different USB identifiers or protocol behavior are not guaranteed to work.

## Technical Summary

```text
Controller:       AsiaHorse Umbra / ROBOBLOQ USBFAN
USB VID:          0x1A86
USB PID:          0xFE05
Interface:        0
Usage Page:       0xFF00
Usage:            0x0001
Physical Ports:   10
Native Header:    52 42
Topology Query:   01 FF
Direct RGB Header: 88
RGBs Per Packet:  20
HID Report ID:    0
HID Payload:      64 bytes
```

The plugin is based on protocol behavior observed from the AsiaHorse Umbra / ROBOBLOQ USBFAN controller.

---

# Phiên bản Tiếng Việt

Plugin SignalRGB tùy chỉnh dành cho **hub ARGB AsiaHorse Umbra / bộ điều khiển ROBOBLOQ USBFAN**.

Plugin giao tiếp trực tiếp với bộ điều khiển thông qua USB HID và cung cấp các channel SignalRGB độc lập cho các cổng ARGB vật lý.

**USB VID:** `0x1A86`  
**USB PID:** `0xFE05`

## Tính năng

- Giao tiếp trực tiếp với bộ điều khiển AsiaHorse Umbra qua USB HID
- 10 channel ARGB độc lập trong SignalRGB
- Tự động phát hiện topology của bộ điều khiển
- Tự động phát hiện số LED trên từng cổng
- Tự động tính kích thước frame Direct RGB
- Tự động lấy mẫu lại màu khi component SignalRGB có số LED khác với số LED vật lý
- Khởi tạo chế độ điều khiển bằng phần mềm
- Tự động thử khởi tạo lại nếu bộ điều khiển chưa sẵn sàng
- Tùy chọn ghi log giao thức và topology
- Không cần phần mềm AsiaHorse chính thức khi SignalRGB đang điều khiển hub

## Các Channel trong SignalRGB

Plugin cung cấp 10 channel độc lập:

```text
ARGB Port 01
ARGB Port 02
ARGB Port 03
ARGB Port 04
ARGB Port 05
ARGB Port 06
ARGB Port 07
ARGB Port 08
ARGB Port 09
ARGB Port 10
```

Plugin không tự động gán component SignalRGB mặc định cho từng channel. Người dùng có thể cấu hình component cần thiết trực tiếp trong SignalRGB.

Đối với cổng đang có thiết bị, số LED do bộ điều khiển báo về được sử dụng làm giới hạn LED của channel đó.

Đối với cổng được báo là trống, channel vẫn được tạo trong SignalRGB nhưng plugin không tự giả định một giới hạn LED cố định.

## Tự động Phát hiện Topology của Cổng

Trong quá trình khởi tạo, plugin truy vấn bộ điều khiển bằng body của lệnh native:

```text
01 FF
```

Topology response quan sát được chứa 10 record tương ứng với 10 cổng vật lý.

Cấu trúc record hiện được xác định như sau:

```text
[Số LED] [Chưa rõ] [Chưa rõ] [Chỉ số Port] [Chưa rõ]
```

Plugin sử dụng:

- `Số LED` để xác định số LED vật lý mà bộ điều khiển hiện báo cho cổng
- `Chỉ số Port` để đưa record vào đúng vị trí cổng vật lý

Các trường còn lại được giữ lại để phục vụ debug nhưng chưa được sử dụng trong quá trình render.

Giới hạn LED tổng của thiết bị trong SignalRGB được tính bằng tổng số LED vật lý phát hiện được trên tất cả các cổng.

## Direct RGB Streaming

Các hiệu ứng Live của SignalRGB được gửi bằng giao thức Direct RGB:

```text
88 [Số Packet] [Chỉ số Packet] [20 x RGB] [Checksum]
```

Mỗi packet Direct RGB chứa 20 giá trị RGB.

Số lượng packet được tính tự động:

```text
Số Packet = ceil(Tổng số LED phát hiện được / 20)
```

Luồng RGB được ghép theo thứ tự cổng vật lý:

```text
ARGB Port 01
ARGB Port 02
ARGB Port 03
...
ARGB Port 10
```

Mỗi cổng đang có thiết bị chiếm chính xác số lượng entry RGB mà bộ điều khiển báo về.

Các cổng được báo có `0` LED sẽ không chiếm vị trí trong luồng Direct RGB.

Packet cuối cùng được bổ sung các giá trị RGB màu đen nếu tổng số LED không chia hết cho 20.

### Ví dụ

Nếu bộ điều khiển báo:

```text
Port 01 = 14 LED
Port 02 = 14 LED
Port 03 = 14 LED
Port 04 = 0 LED
Port 05 = 14 LED
```

thì luồng Direct RGB có:

```text
14 + 14 + 14 + 14 = 56 LED vật lý
```

Plugin sẽ gửi:

```text
ceil(56 / 20) = 3 packet
```

Tổng frame có 60 RGB slot:

```text
56 entry dành cho LED vật lý
4 entry màu đen làm padding
```

## Ánh xạ Màu của Component

Số LED vật lý được lấy từ topology do bộ điều khiển trả về, còn component được cấu hình trong SignalRGB cung cấp dữ liệu màu nguồn.

Nếu hai số lượng LED bằng nhau, màu sẽ được ánh xạ trực tiếp.

Nếu component được cấu hình có số LED khác với số LED vật lý, plugin sẽ lấy mẫu lại màu của component trên toàn bộ số LED vật lý mà bộ điều khiển báo về.

Ví dụ:

```text
Component SignalRGB: 10 LED
Cổng vật lý được controller báo: 14 LED
```

10 màu nguồn sẽ được lấy mẫu lại trên 14 vị trí LED vật lý.

Nếu một cổng đang có thiết bị nhưng chưa được gán component trong SignalRGB, plugin vẫn giữ đúng số lượng vị trí LED vật lý của cổng đó trong luồng Direct RGB và gửi chúng dưới dạng màu đen. Điều này ngăn các cổng phía sau bị lệch vị trí trong luồng dữ liệu.

## Khởi tạo Bộ điều khiển

Sau khi đọc topology thành công và tạo các channel SignalRGB, plugin gửi:

```text
FB 64
```

sau đó gửi:

```text
FD 01
```

`FD 01` được sử dụng để kích hoạt chế độ điều khiển RGB bằng phần mềm.

Ý nghĩa chính xác của `FB 64` chưa được xác nhận hoàn toàn, vì vậy plugin chỉ xem đây là một lệnh startup đã quan sát được thay vì gán cho nó một ý nghĩa giao thức chưa được chứng minh.

Nếu quá trình khởi tạo thất bại, plugin sẽ tự động thử lại theo chu kỳ cố định.

## Cấu trúc Lệnh Native

Các lệnh native của bộ điều khiển sử dụng cấu trúc:

```text
52 42 [Length] 00 [Command Data...] [Checksum]
```

Lệnh được gửi dưới dạng HID payload 64 byte với HID Report ID `0`.

Checksum là tổng cộng dồn 8 bit:

```text
sum(tất cả byte trước checksum) & 0xFF
```

## Cấu trúc Packet Direct RGB

Mỗi packet Direct RGB có cấu trúc:

```text
Byte 0     = 0x88
Byte 1     = tổng số packet
Byte 2     = chỉ số packet bắt đầu từ 1
Byte 3..62 = 20 giá trị RGB
Byte 63    = additive checksum
```

Checksum của packet được tính như sau:

```text
sum(tất cả byte trước checksum) & 0xFF
```

## Debug Logging

Plugin cung cấp tùy chọn:

```text
Log protocol activity to console
```

Khi được bật, plugin có thể ghi các thông tin như:

- Số LED phát hiện được trên từng cổng vật lý
- Tổng số LED phát hiện được
- Các trường topology chưa xác định
- Số packet Direct RGB
- Layout LED vật lý hiện tại
- Thông tin retry khi khởi tạo
- Lỗi transport hoặc lỗi đọc topology

Log trạng thái Direct RGB định kỳ được giới hạn tần suất để tránh tạo quá nhiều output trong console.

## Hướng dẫn Cài đặt

1. Tải tệp `AsiaHorseUmbra.js`.

2. Mở một trong các thư mục plugin của SignalRGB, ví dụ:

```text
Documents\WhirlwindFX\Plugins
```

hoặc:

```text
Documents\SignalRGB\Plugins
```

3. Sao chép `AsiaHorseUmbra.js` vào thư mục plugin.

4. Tắt hoàn toàn phần mềm điều khiển RGB chính thức của AsiaHorse, bao gồm cả tiến trình còn chạy trong System Tray.

5. Khởi động lại SignalRGB hoặc reload plugin.

6. Bộ điều khiển sẽ xuất hiện với tên:

```text
AsiaHorse Umbra ARGB Hub
```

7. Cấu hình component SignalRGB mong muốn cho từng channel ARGB đang có thiết bị kết nối.

## Lưu ý Quan trọng và Giới hạn

### Phần mềm AsiaHorse chính thức

Không nên chạy phần mềm AsiaHorse chính thức đồng thời với SignalRGB. Hai ứng dụng có thể cùng lúc cố gắng giao tiếp với một bộ điều khiển USB HID.

### Topology được phát hiện khi khởi tạo

Plugin đọc topology của các cổng trong quá trình khởi tạo.

Nếu thay đổi thiết bị vật lý được kết nối vào hub trong khi plugin đang chạy, hãy reload plugin hoặc khởi động lại SignalRGB để topology và số LED vật lý được phát hiện lại.

### Số LED do bộ điều khiển báo về

Plugin dựa vào số LED mà bộ điều khiển trả về.

Đối với các cổng đang có thiết bị, giá trị này quyết định:

- Giới hạn LED của channel
- Số lượng RGB vật lý được dành trong luồng Direct RGB
- Tổng số packet Direct RGB

Plugin không giả định một số LED cố định hoặc giới hạn tối đa cố định cho mọi cổng.

### Cổng trống

Các cổng được báo có `0` LED vẫn xuất hiện dưới dạng channel SignalRGB nhưng không chiếm entry RGB trong luồng Direct RGB vật lý.

### Các bộ điều khiển AsiaHorse khác

Khả năng tương thích với các bộ điều khiển RGB AsiaHorse khác chưa được xác minh.

Các bộ điều khiển sử dụng USB ID hoặc hành vi giao thức khác không được đảm bảo sẽ hoạt động.

## Tóm tắt Kỹ thuật

```text
Controller:        AsiaHorse Umbra / ROBOBLOQ USBFAN
USB VID:           0x1A86
USB PID:           0xFE05
Interface:         0
Usage Page:        0xFF00
Usage:             0x0001
Physical Ports:    10
Native Header:     52 42
Topology Query:    01 FF
Direct RGB Header: 88
RGB mỗi Packet:    20
HID Report ID:     0
HID Payload:       64 byte
```

Plugin được xây dựng dựa trên hành vi giao thức quan sát được từ bộ điều khiển AsiaHorse Umbra / ROBOBLOQ USBFAN.
