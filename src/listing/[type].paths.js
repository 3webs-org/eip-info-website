import config from "../../js/config.js";

export default {
    paths() {
        let paths = [];
        // All
        paths.push({
            params: {
                type: "all",
                typeTitleCase: "All",
                filter: {}
            }
        })
        // Types
        for (let type of config.types) {
            if (!(type in config.categories)) {
                paths.push({
                    params: {
                        type: type.toLowerCase().replace(' ', '-'),
                        typeTitleCase: type,
                        filter: {
                            "type": type
                        }
                    }
                })
            }
        }
        // Categories
        for (let type of config.types) {
            if (type in config.categories) {
                for (let category of config.categories[type]) {
                    paths.push({
                        params: {
                            type: category.toLowerCase().replace(' ', '-'),
                            typeTitleCase: category.split(' ').map(w => w[0].toUpperCase() + w.substring(1).toLowerCase()).join(' '),
                            filter: {
                                "category": category
                            }
                        }
                    })
                }
            }
        }
    }
}
