const params = new URLSearchParams(window.location.search)

function setText(id, value) {
    const el = document.getElementById(id)
    if (el) el.innerText = value || "---"
}

function formatAmount(amount) {
    if (!amount) return "---"

    const value = Number(amount) / 100

    return value.toLocaleString("vi-VN") + " VND"
}

function formatPayDate(payDate) {
    if (!payDate) return "---"

    // VNPAY format: yyyyMMddHHmmss
    const year = payDate.slice(0, 4)
    const month = payDate.slice(4, 6)
    const day = payDate.slice(6, 8)
    const hour = payDate.slice(8, 10)
    const minute = payDate.slice(10, 12)
    const second = payDate.slice(12, 14)

    return `${day}/${month}/${year} ${hour}:${minute}:${second}`
}

setText("order_id", params.get("vnp_TxnRef"))
setText("transaction_no", params.get("vnp_TransactionNo"))
setText("bank", params.get("vnp_BankCode"))
setText("amount", formatAmount(params.get("vnp_Amount")))
setText("pay_date", formatPayDate(params.get("vnp_PayDate")))

const statusCode = params.get("vnp_ResponseCode")
const statusEl = document.getElementById("status")
const statusIcon = document.getElementById("statusIcon")

if (statusEl) {
    statusEl.classList.remove("text-green-600", "text-red-600")

    if (statusCode === "00") {
        statusEl.innerText = "Thanh toán thành công"
        statusEl.classList.add("text-green-600")

        if (statusIcon) {
            statusIcon.classList.remove("bg-red-100", "text-red-600")
            statusIcon.classList.add("bg-green-100", "text-green-600")
            statusIcon.innerHTML = `<i class="fa-solid fa-check text-4xl"></i>`
        }
    } else {
        statusEl.innerText = "Thanh toán thất bại"
        statusEl.classList.add("text-red-600")

        if (statusIcon) {
            statusIcon.classList.remove("bg-green-100", "text-green-600")
            statusIcon.classList.add("bg-red-100", "text-red-600")
            statusIcon.innerHTML = `<i class="fa-solid fa-xmark text-4xl"></i>`
        }
    }
}