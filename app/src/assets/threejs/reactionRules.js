export const REACTION_RULES = [

    // =========================================================
    // KIM LOẠI KIỀM
    // =========================================================

    {
        a: "alkali_metal",
        b: "water",
        result: {
            has_reaction: true,
            explosion: true,
            fire: true,
            gas: true,
            smoke: true,
            color: "#ff6600"
        }
    },

    {
        a: "alkali_metal",
        b: "strong_acid",
        result: {
            has_reaction: true,
            explosion: true,
            gas: true,
            fire: true,
            color: "#ff3300"
        }
    },

    {
        a: "alkali_metal",
        b: "halogen",
        result: {
            has_reaction: true,
            explosion: true,
            fire: true,
            gas: true,
            color: "#e6e6fa"
        }
    },



    // =========================================================
    // AXIT + BAZƠ
    // =========================================================

    {
        a: "strong_acid",
        b: "strong_base",
        result: {
            has_reaction: true,
            smoke: true,
            gas: false,
            color: "#ffffff"
        }
    },

    {
        a: "strong_acid",
        b: "weak_base",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#f8f8ff"
        }
    },

    {
        a: "weak_acid",
        b: "strong_base",
        result: {
            has_reaction: true,
            smoke: false,
            color: "#f5f5f5"
        }
    },

    {
        a: "weak_acid",
        b: "weak_base",
        result: {
            has_reaction: true,
            color: "#fafafa"
        }
    },



    // =========================================================
    // CHẤT CHỈ THỊ
    // =========================================================

    {
        a: "indicator_phenol",
        b: "strong_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ff007f"
        }
    },

    {
        a: "indicator_phenol",
        b: "weak_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ff66aa"
        }
    },

    {
        a: "indicator_phenol",
        b: "strong_acid",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },



    // =========================================================
    // MUỐI
    // =========================================================

    {
        a: "salt_solution",
        b: "strong_acid",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#f0f0f0"
        }
    },

    {
        a: "salt_solution",
        b: "strong_base",
        result: {
            has_reaction: true,
            precipitate: true,
            color: "#dfefff"
        }
    },

    {
        a: "salt_solution",
        b: "weak_base",
        result: {
            has_reaction: true,
            precipitate: true,
            color: "#cce0ff"
        }
    },

    {
        a: "salt_solution",
        b: "salt_solution",
        result: {
            has_reaction: true,
            precipitate: true,
            color: "#e6f2ff"
        }
    },



    // =========================================================
    // OXIDIZER (KMnO4)
    // =========================================================

    {
        a: "strong_acid",
        b: "oxidizer",
        result: {
            has_reaction: true,
            smoke: true,
            gas: true,
            color: "#ffcc66"
        }
    },

    {
        a: "oxidizer",
        b: "alcohol",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#dfc4b5"
        }
    },

    {
        a: "oxidizer",
        b: "hydrocarbon",
        result: {
            has_reaction: true,
            fire: true,
            smoke: true,
            color: "#aa5500"
        }
    },

    {
        a: "oxidizer",
        b: "carbohydrate",
        result: {
            has_reaction: true,
            fire: true,
            smoke: true,
            gas: true,
            color: "#5c3a21"
        }
    },

    {
        a: "oxidizer",
        b: "ketone",
        result: {
            has_reaction: true,
            gas: true,
            smoke: true,
            color: "#ff9966"
        }
    },

    {
        a: "oxidizer",
        b: "catalyst",
        result: {
            has_reaction: true,
            gas: true,
            smoke: true,
            color: "#4a4a4a"
        }
    },



    // =========================================================
    // HALOGEN
    // =========================================================

    {
        a: "halogen",
        b: "carbohydrate",
        result: {
            has_reaction: true,
            color: "#000080"
        }
    },

    {
        a: "halogen",
        b: "hydrocarbon",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#663399"
        }
    },

    {
        a: "halogen",
        b: "water",
        result: {
            has_reaction: true,
            color: "#fff2aa"
        }
    },

    {
        a: "halogen",
        b: "ketone",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#ffffcc"
        }
    },



    // =========================================================
    // AXIT + HỮU CƠ
    // =========================================================

    {
        a: "strong_acid",
        b: "alcohol",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#ffe4b5"
        }
    },

    {
        a: "strong_acid",
        b: "carbohydrate",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#3b2f2f"
        }
    },

    {
        a: "strong_acid",
        b: "ketone",
        result: {
            has_reaction: true,
            smoke: true,
            color: "#ffe0cc"
        }
    },



    // =========================================================
    // NƯỚC
    // =========================================================

    {
        a: "water",
        b: "strong_acid",
        result: {
            has_reaction: true,
            smoke: false,
            color: "#dff6ff"
        }
    },

    {
        a: "water",
        b: "strong_base",
        result: {
            has_reaction: true,
            color: "#e8faff"
        }
    },

    {
        a: "water",
        b: "oxidizer",
        result: {
            has_reaction: true,
            gas: true,
            color: "#d8ccff"
        }
    },



    // =========================================================
    // MẶC ĐỊNH HỮU CƠ
    // =========================================================

    {
        a: "alcohol",
        b: "fire_source",
        result: {
            has_reaction: true,
            fire: true,
            color: "#ff8800"
        }
    },

    {
        a: "hydrocarbon",
        b: "fire_source",
        result: {
            has_reaction: true,
            fire: true,
            smoke: true,
            color: "#ff4400"
        }
    }

];

export function detectReaction(a, b) {

    if (!a || !b) {
        return { has_reaction: false };
    }

    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();

    console.log("CHECK REACTION:", a, "+", b);

    for (const rule of REACTION_RULES) {

        if (
           (rule.a === a && rule.b === b) ||
           (rule.a === b && rule.b === a)
        ) {

            console.log("REACTION FOUND:", rule);

            return {
                has_reaction: true,
                ...rule.result
            };
        }
    }

    console.warn("NO REACTION:", a, b);

    return {
        has_reaction: false
    };
}
