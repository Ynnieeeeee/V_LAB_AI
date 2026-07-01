document.addEventListener("DOMContentLoaded", () => {

    const userArea = document.getElementById("user-area")
    if (!userArea) return

    const user = JSON.parse(localStorage.getItem("user"))

    if (user) {

        userArea.innerHTML = `
            <div class="relative text-white">

                <div id="user-btn"
                    class="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-xl hover:bg-white/10 transition">

                    <img src="${user.avatar}"
                        class="w-8 h-8 rounded-full object-cover border border-white/30">

                    <span class="text-sm font-medium">
                        ${user.username}
                    </span>
                </div>

                <div id="dropdown-menu"
                    class="hidden absolute right-0 top-full mt-3 w-44 bg-white text-black rounded-xl shadow-xl border overflow-hidden">

                    <button id="update-btn"
                        class="w-full text-left px-4 py-3 text-sm hover:bg-gray-100 flex items-center gap-2">
                        <i class="fa-solid fa-crown text-yellow-500"></i>
                        Upgrade
                    </button>  

                    <button id="logout-btn"
                        class="w-full text-left px-4 py-3 text-sm hover:bg-gray-100 flex items-center gap-2">
                        <i class="fa-solid fa-right-from-bracket text-gray-600"></i>
                        Log out
                    </button>

                </div>

            </div>
        `

        const btn = document.getElementById("user-btn")
        const menu = document.getElementById("dropdown-menu")

        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            menu.classList.toggle("hidden")
        })

        document.addEventListener("click", (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.add("hidden")
            }
        })

        document.getElementById("logout-btn").addEventListener("click", () => {
            localStorage.removeItem("user")
            localStorage.removeItem("access_token")
            location.reload()
        })

        document.getElementById("update-btn").addEventListener("click", () => {
            window.location.href = "/assets/subscription.html"
        })

    }

    else {

        userArea.innerHTML = `
            <a href="/login">
                <button
                    class="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-xl text-sm font-semibold transition shadow-lg">
                    Log in
                </button>
            </a>
        `
    }

})
