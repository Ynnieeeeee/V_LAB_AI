from langchain_text_splitters import RecursiveCharacterTextSplitter
from app.scripts.load_documents import load_documents

def clean_text(text: str) -> str:
    """Làm sạch vb trước khi chia nhỏ"""
    text = text.replace("\n", " ")
    text = " ".join(text.split())
    return text

def chunk_document(docs=None):
    """Chia nhỏ document thành các đoạn ngắn"""
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=100,
        add_start_index=True,
        separators=["\n\n", "\n", ".", " ", ""]
    )

    if docs is None:
        print("Đang nạp dữ liệu từ file pdf")
        documents = load_documents()
    else:
        documents = docs

    if not documents:
        print("Không có tài liệu nào cần chia nhỏ")
        return []
    
    for doc in documents:
        doc.page_content = clean_text(doc.page_content)

    print(f"Đang chia nhỏ {len(documents)} tài liệu")
    splits = text_splitter.split_documents(documents)
    print(f"Hoàn tất: {len(documents)} Docs -> {len(splits)} Chunks")
    return splits

if __name__ == "__main__":
    all_splits = chunk_document()
    
    if all_splits:
        print("\nKiểm tra đoạn đầu tiên")
        print(f"Nội dung: {all_splits[0].page_content}")
        print(f"Metadata: {all_splits[0].metadata}")
