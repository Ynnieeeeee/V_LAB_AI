const params = new URLSearchParams(window.location.search);
const tokenFromURL = params.get("token");

const API_BASE = window.location.origin;

if (tokenFromURL) {
    fetch(`${API_BASE}/auth/me`, {
        headers: {
            Authorization: "Bearer " + tokenFromURL
        }
    })
    .then(res => {
        if (!res.ok) {
            throw new Error("Token không hợp lệ");
        }
        return res.json();
    })
    .then(user => {
        localStorage.setItem("access_token", tokenFromURL);

        localStorage.setItem("user", JSON.stringify({
            username: user.username,
            avatar: user.avt_url,
            email: user.email
        }));

        window.history.replaceState({}, "", "/");
        location.reload();
    })
    .catch(err => {
        console.error(err);
        localStorage.removeItem("access_token");
        localStorage.removeItem("user");
    });
}

async function checkLogin() {
    const token = localStorage.getItem("access_token");

    if (!token) return;

    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (res.status === 401) {
            logout();
        }
    } catch (err) {
        console.error(err);
    }
}

function logout() {
    localStorage.removeItem("access_token");
    localStorage.removeItem("user");
    window.location.href = "/login";
}

document.addEventListener("DOMContentLoaded", () => {
    checkLogin();
});