document.addEventListener("DOMContentLoaded", () => {
    const requestPayment = async (token, planId) => {
        const requestOptions = {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ plan_id: planId })
        }

        const localResponse = await fetch("/payment", requestOptions)

        if (![404, 405].includes(localResponse.status)) {
            return localResponse
        }

        const fallbackEndpoint = `${window.location.protocol}//${window.location.hostname}:8001/payment`
        return fetch(fallbackEndpoint, requestOptions)
    }

    document.querySelectorAll(".upgrade-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (btn.dataset.loading === "true") return
            btn.dataset.loading = "true"

            const oldText = btn.innerText
            btn.innerText = "Đang xử lý..."
            btn.disabled = true

            try {
                const token = localStorage.getItem("access_token")
                const planId = btn.dataset.plan

                if (!token) {
                    alert("Vui lòng đăng nhập trước khi nâng cấp gói")
                    window.location.href = "/login"
                    return
                }

                if (!planId) {
                    alert("Nút nâng cấp chưa có data-plan")
                    return
                }

                const res = await requestPayment(token, planId)

                let data = {}
                try {
                    data = await res.json()
                } catch (_) {
                    data = {}
                }

                if (!res.ok) {
                    alert(data.detail || data.error || "Không tạo được link thanh toán")
                    return
                }

                if (data.payment_url) {
                    window.location.href = data.payment_url
                    return
                }

                if (data.redirect_url) {
                    alert(data.message || "Nâng cấp gói thành công")
                    window.location.href = data.redirect_url
                    return
                }

                alert(data.message || "Thao tác thành công")
            } catch (err) {
                console.error("Payment error:", err)
                alert("Lỗi kết nối tới server")
            } finally {
                delete btn.dataset.loading
                btn.innerText = oldText
                btn.disabled = false
            }
        })
    })
})
