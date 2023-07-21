import options from "../../.vitepress/options.js";

export default {
    paths() {
        let paths = [];
        // All
        paths.push({
            params: {
                type: "all",
                title: "All",
                listing: true,
                filter: {}
            }
        })
        // Types
        for (let type of options.types) {
            if (!(type in options.categories)) {
                paths.push({
                    params: {
                        type: type.toLowerCase().replace(' ', '-'),
                        title: type,
                        listing: true,
                        filter: {
                            "type": [
                                type
                            ]
                        }
                    }
                })
            }
        }
        // Categories
        for (let type of options.types) {
            if (type in options.categories) {
                for (let category of options.categories[type]) {
                    paths.push({
                        params: {
                            type: category.toLowerCase().replace(' ', '-'),
                            title: category.split(' ').map(w => w[0].toUpperCase() + w.substring(1).toLowerCase()).join(' '),
                            listing: true,
                            filter: {
                                "category": [
                                    category
                                ]
                            }
                        }
                    })
                }
            }
        }
        return paths;
    }
}
