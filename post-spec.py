import json, urllib.request

text = """so code hiện tại với quy trình này, thay đổi nếu cần:

B. Ngày 0 — nhận và sàng lọc
Nhận acc, đăng nhập từng cái trên antidetect browser, mỗi acc một profile riêng, proxy residential đúng metro. Ghi vào bảng theo dõi rồi đóng lại. Ngày 0 không đổi gì, không sửa profile.
Đánh dấu loại nếu: không đăng nhập được, có email lạ, profile trống hoàn toàn, city sai metro.

C. Ngày 1–5 — dựng hồ sơ
Mỗi ngày, mỗi acc 60–90 giây:
Việc | Ngày
Ảnh đại diện thật (chân dung đời thường, không stock, không mặt AI bóng bẩy) | 1
Đổi tên hiển thị nếu cần, thêm họ đầy đủ | 1
Bio một dòng, tự nhiên ("Local, thích ăn uống" — không nhồi nghề) | 2
Kết 2–3 bạn (acc trong cùng lô cũng được, nhưng phải khác lô mua) | 2–5
Duyệt 3–4 trang, xem địa điểm ở city hiện tại | 1–5
Viết 1 tip ngắn ở quán cà phê / tiệm bánh bất kỳ | 4
Không viết review trong 5 ngày này.

D. Ngày 6 — đổi city
Chỉ đổi một lần, sang metro của khách. Đổi rồi không đổi lại.
Nếu acc đã có 8+ review ở city cũ thì bỏ qua bước này, dùng acc cho đúng metro gốc.

E. Ngày 6–12 — neo vị trí mới
Mỗi ngày: duyệt 3–4 địa điểm trong metro mới, check-in 1 chỗ, vote "Useful" cho 2–3 review của người khác. Ngày 10–12 viết thêm 1 tip.
Mục tiêu: acc có lịch sử duyệt và check-in tại metro mới trước khi review bất cứ thứ gì.

F. Ngày 13–21 — review mồi
3 review mồi, cách nhau 2–4 ngày (ngày 13, 16, 19). Không đều tăm tắp.
Chọn điểm mồi:
Cùng metro, quận khác với khách, ngành khác nếu có thể
Doanh nghiệp thật, đang sống, đã có 20+ review — review mồi rơi vào đó không ai soi
Có ảnh thật trên trang để acc xem trước
80–150 từ, nêu món/dịch vụ cụ thể, nêu tên nhân viên nếu có, nêu khu phố, có một điểm chê nhẹ. 1 ảnh riêng, góc khác ảnh đã dùng.
Thỉnh thoảng cho 4 sao, đừng 5 sao hết.
Check-in trước khi viết. Sau khi đăng, để acc hoạt động 3–5 ngày.

G. Cổng kiểm tra — chỉ dùng cho khách khi qua đủ 6 điều kiện
Nuôi đủ 21 ngày
3 review mồi đã sống ≥72 giờ
Home city khớp metro của khách
Có ảnh đại diện thật, bio, ≥2 bạn bè
Có ≥1 check-in trong metro của khách
Không có review nào bị lọc trong 14 ngày gần nhất
Phân hạng theo kết quả:
Đạt | Hạng | Dùng cho
6/6 | A | Khách trả cao, khách sạn, nhà hàng, ngành khó
5/6 | B | Khách thường
4/6 | C | Hàng giá thấp, chỉ 1 lần rồi bỏ
Dưới 4 | Loại | Không dùng

H. Ngày đăng review thật
Check-in tại doanh nghiệp trước khi viết
Đăng trong khung giờ địa phương hợp lý, không 2–3 giờ sáng
1 review/ngày/acc, tối đa 1–2 review/ngày/doanh nghiệp
Không đăng 2 acc cùng lô cho cùng doanh nghiệp trong cùng ngày
Sau khi đăng, chụp màn hình, ghi giờ, ghi ID acc vào bảng theo dõi

I. Ngày 22–51 — duy trì
Đăng nhập mỗi 2 ngày, duyệt 2 phút, vote 1–2 cái. Không để acc ngủ ngay sau khi review — đó là chữ ký spam.
Kiểm tra review ở ngày 2, 7, 14, 30. Ghi lại trạng thái từng mốc. Bị lọc ở mốc nào cũng ghi, không xoá dấu vết.

J. Vòng đời acc
Tái dùng tối đa 4 lần, cách nhau 3–4 tuần, khác doanh nghiệp, khác quận, cùng metro
Lần 4 xong: cho nghỉ 30 ngày, chuyển sang hạng C
Acc bị lọc 2 lần liên tiếp: loại khỏi danh sách khách trả cao
Acc bị lọc 3 lần: bỏ hẳn

(Còn tiếp — tôi sẽ gửi thêm.)"""

req = urllib.request.Request(
    "http://127.0.0.1:4310/api/conversations/group/messages",
    data=json.dumps({"text": text}).encode(),
    method="POST",
    headers={"content-type": "application/json"},
)
res = json.load(urllib.request.urlopen(req))
print("posted id:", res["message"]["id"], "| len:", len(res["message"]["text"]))
