const params = new URLSearchParams(window.location.search)
const tokenFromURL = params.get("token")

if (tokenFromURL) {
    fetch("http://127.0.0.1:8000/auth/me", {
        headers: {
            Authorization: "Bearer " + tokenFromURL
        }
    })
    .then(res => {
        if (!res.ok) {
            throw new Error("Token không hợp lệ")
        }
        return res.json()
    })
    .then(user => {
        localStorage.setItem("access_token", tokenFromURL)

        const userData = {
            username: user.username,
            avatar: user.avt_url
        }

        localStorage.setItem("user", JSON.stringify(userData))
        window.history.replaceState({}, document.title, "/")
        location.reload()
    })
    .catch(err => {
        console.error(err)
        localStorage.removeItem("access_token")
        localStorage.removeItem("user")
    })
}

async function checkLogin(){
    const token = localStorage.getItem("access_token")
    if(!token) return

    try{
        const res = await fetch("http://127.0.0.1:8000/auth/me",{
            headers:{
                Authorization:`Bearer ${token}`
            }
        })

        if(res.status === 401){
            logout()
        }
    }catch(err){
        console.error(err)
    }
}

function logout(){
    localStorage.removeItem("access_token")
    localStorage.removeItem("user")
    window.location.href = "/login"
}

document.addEventListener("DOMContentLoaded", function(){
    checkLogin()
})

