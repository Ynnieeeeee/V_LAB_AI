export const REACTION_RULES = [
    {
        a: "alkali_metal",
        b: "water",
        result: {
            has_reaction: true,
            explosion: true,
            gas: true,
            color: "#ff6600"
        }
    },
    {
        a: "acid",
        b: "base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },
    {
        a: "strong_acid",
        b: "strong_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },
    {
        a: "strong_acid",
        b: "weak_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },
    {
        a: "weak_acid",
        b: "strong_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },
    {
        a: "weak_acid",
        b: "weak_base",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffff"
        }
    },
    {
        a: "strong_acid",
        b: "salt_solution",
        result: {
            has_reaction: true,
            gas: false,
            color: "#f5f5f5"
        }
    },
    {
        a: "strong_base",
        b: "salt_solution",
        result: {
            has_reaction: true,
            gas: false,
            color: "#0074d9"
        }
    },
    {
        a: "weak_base",
        b: "salt_solution",
        result: {
            has_reaction: true,
            gas: false,
            color: "#0055ff"
        }
    },
    {
        a: "salt_solution",
        b: "salt_solution",
        result: {
            has_reaction: true,
            gas: false,
            color: "#e6f2ff"
        }
    },
    {
        a: "halogen",
        b: "carbohydrate",
        result: {
            has_reaction: true,
            gas: false,
            color: "#000080"
        }
    },
    {
        a: "halogen",
        b: "alkali_metal",
        result: {
            has_reaction: true,
            explosion: true,
            fire: true,
            gas: true,
            color: "#e6e6fa"
        }
    },
    {
        a: "oxidizer",
        b: "organic",
        result: {
            has_reaction: true,
            fire: true,
            gas: true,
            color: "#ff0000"
        }
    },
    {
        a: "oxidizer",
        b: "alcohol",
        result: {
            has_reaction: true,
            gas: false,
            color: "#dfc4b5"
        }
    },
    {
        a: "oxidizer",
        b: "hydrocarbon",
        result: {
            has_reaction: true,
            gas: false,
            color: "#dfc4b5"
        }
    },
    {
        a: "oxidizer",
        b: "carbohydrate",
        result: {
            has_reaction: true,
            fire: true,
            gas: true,
            color: "#5c3a21"
        }
    },
    {
        a: "oxidizer",
        b: "catalyst",
        result: {
            has_reaction: true,
            gas: true,
            color: "#4a4a4a"
        }
    },
    {
        a: "ketone",
        b: "halogen",
        result: {
            has_reaction: true,
            gas: false,
            color: "#ffffcc"
        }
    },
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
            color: "#ff007f"
        }
    }
];

export function detectReaction(type1, type2) {

    if (!type1 || !type2) {
        return {
            has_reaction: false
        };
    }

    type1 = type1.toLowerCase().trim();
    type2 = type2.toLowerCase().trim();

    for (const rule of REACTION_RULES) {

        const matched =
            (rule.a === type1 && rule.b === type2) ||
            (rule.a === type2 && rule.b === type1);

        if (matched) {
            return rule.result;
        }
    }

    return {
        has_reaction: false
    };
}
