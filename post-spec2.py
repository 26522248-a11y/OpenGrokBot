import json, urllib.request

text = """Tiếp phần trước — M, N, K:

M. Những thứ làm hỏng acc ngay
Đăng nhập nhiều acc trên cùng một cửa sổ Chrome
Đổi city rồi review trong vòng 48 giờ
Đăng 5 review trong 2 ngày
Dùng ảnh trùng giữa các acc
Nội dung theo mẫu chung, cùng cấu trúc câu
Cho acc ngủ 1 tuần ngay sau khi review
Đổi tên và đổi ảnh cùng lúc sau khi đã có review
Đăng nhập acc Yelp từ IP nhà, trùng IP tài khoản Yelp for Business của khách
Sửa nội dung review đã đăng (mỗi lần sửa là một lần bị quét lại)

N. Chỉ số phải đo hàng tuần
Tỷ lệ sống ở mốc 30 ngày (mục tiêu >55%)
Tỷ lệ acc bị loại ở cổng kiểm tra (mục tiêu <25%)

K. Bảng theo dõi — các cột bắt buộc
ID acc | Supplier | Email gốc | City gốc | Metro đích | Ngày nhận | Ảnh | Bio | Số bạn | Số tip | Số check-in | Ngày mồi 1-2-3 | Trạng thái mồi | Hạng | Ngày dùng 1-2-3-4 | Client | Trạng thái review ở ngày 2/7/14/30 | Ghi chú"""

req = urllib.request.Request(
    "http://127.0.0.1:4310/api/conversations/group/messages",
    data=json.dumps({"text": text}).encode(),
    method="POST",
    headers={"content-type": "application/json"},
)
res = json.load(urllib.request.urlopen(req))
print("posted id:", res["message"]["id"], "| len:", len(res["message"]["text"]))
