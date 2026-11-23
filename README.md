# Apple ID Login Checker

Ứng dụng Electron kiểm tra thông tin đăng nhập Apple ID bằng hàm `CHBMAppleID` trong `ipv4.js`.

## Chạy ứng dụng

Yêu cầu Node.js và npm. Cài dependency rồi mở app:

```sh
npm install
npm start
```

Đóng gói bằng `npm run package` hoặc tạo bộ cài bằng `npm run make` trên hệ điều hành tương ứng. Tên app và bộ cài: **Apple ID Login Checker**.

## Sử dụng

1. Chọn file Apple ID UTF-8, mỗi dòng `email|password`. Mật khẩu được giữ nguyên, kể cả ký tự `|` và khoảng trắng. Bỏ dòng trống, chỉ loại các dòng trùng hoàn toàn; các mật khẩu khác nhau của cùng email vẫn là dữ liệu riêng.
2. Chọn file proxy nếu cần: `host:port` hoặc `host:port:user:pass`. Bỏ đường dẫn proxy để kết nối trực tiếp. Dòng proxy trống/trùng được bỏ qua; proxy sai định dạng chặn bắt đầu.
3. Chọn **Thư mục output** bằng nút **Chọn thư mục** hoặc dán đường dẫn. Để trống để dùng thư mục mặc định. Lựa chọn được lưu cho lần mở sau. Chọn số luồng nguyên từ 1–200, mặc định 5, rồi bấm **Bắt đầu kiểm tra**.
4. **Tạm dừng** ngừng lấy dòng mới, không bắt đầu retry mới và chờ request đang chạy kết thúc; **Tiếp tục kiểm tra** tiếp tục cùng phiên, giữ số lần đã thử và không chạy lại dòng đã lưu. Mỗi lần đăng nhập có timeout request 30 giây và deadline 90 giây. Lỗi mạng/proxy, timeout hoặc HTTP 503 được retry tối đa **3 lần sau lần đầu** (tối đa 4 lần gọi), chờ lần lượt 1, 2 và 3 giây. Các lần thử giữ cùng proxy và cùng một worker, không tăng số luồng. Sai mật khẩu, tài khoản khóa, proxy sai định dạng và phản hồi chưa xác định không tự retry. Chỉ ghi kết quả cuối cùng vào file và thống kê.
5. **Mở thư mục kết quả** mở thư mục riêng của phiên. **Xuất chưa kiểm tra** xuất các dòng chưa chạy cùng các dòng `unchecked`, để dùng làm đầu vào cho phiên sau. File gốc và các file kết quả không bị ghi đè bởi chức năng xuất này.
6. **Phiên mới** xóa trạng thái trên giao diện, giữ các file kết quả cũ. Có thể đổi dữ liệu/cấu hình sau khi tạo phiên mới.

Trạng thái pause/resume giữ trong bộ nhớ khi app còn mở. Đóng cửa sổ hoặc thoát app sẽ chờ tác vụ đang chạy xong trước khi đóng. Muốn tiếp tục sau khi mở lại app, xuất file chưa kiểm tra trước khi đóng rồi dùng file đó làm đầu vào.

## Kết quả

Tự động lưu trong thư mục `run-*` bên trong **Thư mục output** đã chọn, ghi ngay sau từng dòng. Nếu để trống, mặc định dùng `AppleIDResults/run-*` bên dưới `app.getPath('userData')`. Đường dẫn thực tế của phiên hiển thị dưới phần kết quả; nút **Mở thư mục kết quả** mở đúng thư mục đó. Chỉ đổi thư mục output trước khi bắt đầu phiên hoặc sau khi bấm **Phiên mới**.

- `valid.txt`: Apple chấp nhận thông tin đăng nhập (`successfully` hoặc `CHBM`); trường hợp CHBM vẫn cần bước xác minh bổ sung.
- `invalid.txt`: phản hồi sai thông tin đăng nhập (HTTP 401).
- `unchecked.txt`: tài khoản khóa (HTTP 403), lỗi mạng/proxy, timeout, dịch vụ lỗi (bao gồm HTTP 503), phản hồi chưa xác định hoặc dòng sai định dạng.

Mọi file kết quả (`valid.txt`, `invalid.txt`, `unchecked.txt`, `pending.txt`) giữ định dạng đầu vào `email|password`, không thêm status/reason. Các dòng sai định dạng được giữ nguyên trong `unchecked.txt` để có thể sửa lại. Mật khẩu không được truyền tới bảng kết quả trên giao diện. Các file kết quả có chứa mật khẩu để phục vụ xuất/đối soát.

Ứng dụng chỉ thực hiện kiểm tra đăng nhập; không thực hiện sửa ngày sinh, câu hỏi bảo mật hay thông tin tài khoản.

## Kiểm tra

```sh
npm test
npm run test:electron
```

`npm test` chạy kiểm tra parser, giới hạn luồng, pause/resume, lỗi ghi file, phân loại phản hồi và hủy request khi hết hạn. Không cần dependency ngoài Node.js cho bộ kiểm tra này.

`npm run test:electron` chạy trực tiếp UI và IPC trên Electron với phản hồi giả lập: chọn file, bắt đầu, chặn chạy chồng, tạm dừng/tiếp tục, thống kê, xuất dữ liệu, bảo vệ file đầu vào, chặn cửa sổ lạ và đóng cửa sổ khi còn tác vụ. Toàn bộ dữ liệu kiểm tra là giả lập; không đăng nhập tài khoản Apple thật.
