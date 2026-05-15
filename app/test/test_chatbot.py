from app.task.rag import ask_questions

def test_terminal():
    print("V_LAB_AI TERMINAL TEST")
    print("Hệ thống hỗ trợ: biology, chemistry, physics, history")
    
    # Cho phép chọn môn học trước để test tính năng lọc metadata
    subject = input("Chọn môn học muốn test (vd: chemistry): ").strip().lower()
    
    # Khởi tạo lịch sử chat rỗng
    history = []

    print(f"\nĐang kết nối với phòng Lab: {subject.upper()}")
    print("(Nhập 'exit' để dừng, 'change' để đổi môn học)\n")

    while True:
        question = input("Bạn hỏi: ")

        if question.lower() == "exit":
            break
        
        if question.lower() == "change":
            subject = input("Chọn môn học mới: ").strip().lower()
            history = [] # Reset lịch sử khi đổi môn
            print(f"Đã đổi sang: {subject.upper()}")
            continue

        try:
            # Gọi hàm xử lý từ rag.py
            # Truyền thêm subject để Agent gọi tool retrieved_context chính xác
            answer = ask_questions(question, selected_subject=subject, history=history)

            print(f"\nMascot ({subject}): {answer}\n")
            
            # Cập nhật lịch sử để test khả năng nhớ ngữ cảnh của Agent
            # history.append(("user", question))
            # history.append(("assistant", answer))

        except Exception as e:
            print(f"Có lỗi xảy ra: {e}")

if __name__ == "__main__":
    test_terminal()