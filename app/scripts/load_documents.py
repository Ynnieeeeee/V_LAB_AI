import os
import pytesseract
from pdf2image import convert_from_path
from langchain_core.documents import Document

folder = "app/data/pdf"
subjects = ["biology", "chemistry", "physics"]

def load_documents(file_path=None, subject_tag="general"):
    """
        Sử dụng OCR để trích xuất văn bản từ PDF dạng ảnh.
        Trả về danh sách các đối tượng Document
    """
    documents = []

    def process_file(path, subject_tag):
        results = []
        try:
            print(f"Đang OCR tài liệu: {path}")
            
            print(f"Đang chuyển đổi PDF sang ảnh (vui lòng đợi)...", flush=True)
            #Đọc pdf và trả về ds ảnh
            pages = convert_from_path(path, 300)
            print(f"Đã chuyển đổi xong {len(pages)} trang. Bắt đầu OCR...", flush=True)

            #lặp qua từng ảnh
            for i, page_image in enumerate(pages):
                #ORC ảnh thành vb
                print(f"Đang quét trang {i+1}/{len(pages)}")
                text = pytesseract.image_to_string(page_image, lang='vie+eng')

                #giải phóng bộ nhớ sau khi ORC xong 1 trang
                page_image.close()

                new_doc = Document(
                    page_content=text,
                    metadata={
                        "source": path,
                        "page": i + 1,
                        "subject": subject_tag
                    }
                )
                results.append(new_doc)
            return results
        except Exception as e:
            print(f"Lỗi khi xử lý {path}: {e}")
            return []
        
    if file_path:
        return process_file(file_path, subject_tag)
    
    for subject in subjects:
        subject_path = os.path.join(folder, subject)
        if not os.path.exists(subject_path):
            continue

        for file_name in os.listdir(subject_path):
            if file_name.endswith(".pdf"):
                full_path = os.path.join(subject_path, file_name)
                docs = process_file(full_path, subject)
                documents.extend(docs)
    
    return documents

if __name__=="__main__":
    all_docs = load_documents()
    print(f"Tổng số trang đã ORC: {len(all_docs)}")
