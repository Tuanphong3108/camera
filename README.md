# 📸 Camera

Ứng dụng camera chạy ngay trên trình duyệt, cài được như một ứng dụng độc lập (**PWA**). Giao diện lấy cảm hứng từ **Camera của ChromeOS**, thiết kế theo **Material 3 Expressive**.

👉 [tuanphong3108.github.io/camera](https://tuanphong3108.github.io/camera/)

---

## 🚀 Tính năng

- 🎥 **Video**: quay thường, tạo **GIF** (tối đa 5 giây) hoặc video **Time Lapse**
- 📷 **Ảnh**: chụp ảnh, bộ lọc áp dụng thẳng vào ảnh chụp
- 📄 **Quét tài liệu** kiểu ChromeOS: khung vàng tự bám tờ giấy, chụp xong được nắn phẳng, xem lại, **thêm nhiều trang**, chỉnh góc, lưu thành **ảnh** hoặc **PDF** (hoặc chia sẻ); quét **mã QR** (sao chép / mở liên kết)
- ⏱ **Hẹn giờ** 3 / 5 / 10 giây, dùng được cả khi quay video
- 🪞 Phản chiếu, lưới 3×3, đổi camera, tắt/bật micrô
- 📂 **Thư mục lưu ảnh**: menu 3 chấm → *Thư mục lưu ảnh*; ảnh và video ghi thẳng vào thư mục đã chọn (không có thì tải về như bình thường). Danh sách thư mục **đồng bộ hai chiều với Photos** (thêm / hủy theo dõi ở đâu thì bên kia theo); thư mục mới hoặc thư mục đang lưu bị xóa thì Camera hỏi lại lưu vào đâu
- 🖼 **Kết nối với Photos**: thư mục lưu ảnh được thêm luôn vào [Photos](https://github.com/Tuanphong3108/photos), nút ảnh nhỏ ở góc dưới bên phải mở Photos (dạng PWA nếu đã cài) và phóng to đúng tấm vừa chụp
- 🚀 **Hướng dẫn bắt đầu** (giống Media Player), xem lại ở menu 3 chấm
- 🌍 Tiếng Việt & English, đổi ngay trong app (menu 3 chấm → *Ngôn ngữ*)
- 📡 Dùng được offline nhờ cache PWA

> Lưu thẳng vào thư mục dùng File System Access API (Chrome / Edge / Chromium). Trình duyệt không hỗ trợ thì ảnh được tải về.

---

## 🗂 Cấu trúc

| Tệp | Vai trò |
| --- | --- |
| `index.html`, `style.css`, `app.js` | Giao diện và logic chính |
| `i18n.js` + `language/vi.lang`, `language/en.lang` | Đa ngôn ngữ (file `.lang` dạng `key=value`, giống Media Player) |
| `getting_started.html` | Hướng dẫn bắt đầu (nhúng bằng iframe) |
| `scanner.js` | Lõi quét tài liệu: nhận diện góc giấy, nắn phẳng, ghi PDF |
| `ml-detect.js` + `vendor/ml/` | Mô hình AI nhẹ DocCornerNet (~3,5 MB, ONNX Runtime Web, MIT) tìm 4 góc tài liệu, chạy ngay trên máy; chỉ tải khi vào Quét → Tài liệu. AI không chắc thì dùng OpenCV |
| `vendor/opencv.js` | OpenCV.js (~10 MB), chỉ nạp khi vào Quét → Tài liệu để cắt góc chính xác; chưa nạp xong thì dùng bộ nhận diện nhẹ trong `scanner.js` |
| `gif-encoder.js` | Bộ mã hóa GIF nhỏ gọn, không phụ thuộc thư viện |
| `icons.js` + `fonts/symbols-subset.woff2` | Material Symbols (font con) |
| `vendor/mwc.js` | Material Web Components (đóng gói sẵn, chạy offline) |

**Thêm ngôn ngữ:** tạo `language/<mã>.lang` (sao chép `en.lang`), rồi thêm mã đó vào `LANGS` trong `i18n.js` và một dòng trong hộp thoại ngôn ngữ ở `index.html`.

---

## ⚠️ Lưu ý

- Các ứng dụng cùng `tuanphong3108.github.io` dùng chung bộ nhớ trình duyệt, nên cài đặt của Camera được đặt tiền tố `camera.` để không đụng nhau.
- Người dùng bản cũ: lựa chọn ngôn ngữ trước đây được chuyển sang cài đặt mới tự động.

💡 Dự án cá nhân, mục tiêu **đủ xài, nhẹ, tiện**: chỉ cần trình duyệt, không cần cài gì thêm.
