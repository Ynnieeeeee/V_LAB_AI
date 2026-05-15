from sqlmodel import Session, select
from app.models.documents import Documents
from app.models.base_db import engine
import os
import uuid

base_folder = "app/data/pdf"
subjects = ["chemistry", "physics", "biology"]

def load_pdfs():
    """Lưu vào table documents"""
    with Session(engine) as session:
        for subject in subjects:
            subject_path = os.path.join(base_folder, subject)
            if not os.path.exists(subject_path):
                print(f"Thư mục không tồn tại: {subject_path}")
                continue
            
            #chỉ xử lý những file có đuôi .pdf
            for file_name in os.listdir(subject_path):
                if not file_name.endswith(".pdf"):
                    continue

                file_path = os.path.join(subject_path, file_name)

                stmt = select(Documents).where(Documents.source == file_path)
                existing_doc = session.exec(stmt).first()
                if existing_doc:
                    print(f"Đã tồn tại, bỏ qua: {file_name}")
                    continue

                print(f"Đang nạp {subject.upper()}: {file_name}")

                doc = Documents(
                    id_doc=uuid.uuid4(),
                    title=file_name,
                    source=file_path,
                    doc_metadata={"subject": subject}
                )
                session.add(doc)
        session.commit()
        print("Quá trình lưu file pdf vào documents hoàn tất")

if __name__=="__main__":
    load_pdfs()


