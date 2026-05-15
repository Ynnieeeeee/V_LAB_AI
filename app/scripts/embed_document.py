from langchain_huggingface import HuggingFaceEmbeddings
from langchain_postgres import PGVector
from app.config import DATABASE_URL
from app.scripts.document_chunk import chunk_document

embeddings = HuggingFaceEmbeddings(
    model_name="intfloat/multilingual-e5-base",
    encode_kwargs={"batch_size": 32}
)

connection = DATABASE_URL

vector_store = PGVector(
    embeddings=embeddings,
    connection=connection,
    collection_name="data_chunks"
)

def embed_document(chunks=None):
    if chunks is None:
        chunks = chunk_document()

        for doc in chunks:
            if not doc.page_content.startswith("passage: "):
                doc.page_content = "passage: " + doc.page_content

        print("Start embedding...")

        #Mỗi lần thêm 100 chunk vào db
        batch_size = 100
        total = 0

        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i+batch_size]
            ids = vector_store.add_documents(batch)
            total += len(ids)
            print(f"Đã tạo {total} vector")

        print("Tổng số vector đã tạo:", total)
        return total
    
if __name__=="__main__":
    embed_document()

