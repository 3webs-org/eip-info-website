import fs from 'node:fs/promises';

import { createLogger } from 'vite-logger';
import { Feed } from 'feed';
import { withPwa } from '@vite-pwa/vitepress';
import { defineConfig } from 'vitepress';

import config from "../js/config.js";

const logger = createLogger('info', true);

export default withPwa(defineConfig({
    srcDir: './src',
    title: 'Ethereum Improvement Proposals',
    description: 'Ethereum Improvement Proposals (EIPs) describe standards for the Ethereum platform, including core protocol specifications, client APIs, and contract standards.',
    cleanUrls: true,
    base: '/',
    themeConfig: {
        logo: '/img/ethereum-logo.svg',
        outline: 'deep',
        lastUpdatedText: 'Last Updated',
        nav: [
            { text: 'All', link: '/listing/all' },
            { text: 'Core', link: '/listing/core' },
            { text: 'Networking', link: '/listing/networking' },
            { text: 'Interface', link: '/listing/interface' },
            { text: 'ERC', link: '/listing/erc' },
            { text: 'Meta', link: '/listing/meta' },
            { text: 'Informational', link: '/listing/informational' }
        ],
        search: {
          provider: 'local'
        },
    },
    head: [
        [ 'meta', { charset: 'utf-8' } ],
        [ 'meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' } ],
        [ 'meta', { 'http-equiv': 'X-UA-Compatible', content: 'IE=edge,chrome=1' } ],
        [ 'meta', { name: 'Content-Type', content: 'text/html; charset=utf-8' } ],
        [ 'meta', { name: 'robots', content: 'index, follow' } ],
        [ 'meta', { name: 'google-site-verification', content: 'WS13rn9--86Zk6QAyoGH7WROxbaJWafZdaPlecJVGSo' } ], // Gives @Pandapip1 limited access (analytics & re-indexing) to Google Search Console; access can be revoked at any time by removing this line
        [ 'link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/img/apple-touch-icon.png' } ],
        [ 'link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/img/favicon-32x32.png' } ],
        [ 'link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/img/favicon-16x16.png' } ],
        [ 'link', { rel: 'mask-icon', href: '/img/safari-pinned-tab.svg', color: '#5bbad5' } ],
        [ 'link', { rel: 'shortcut icon', href: '/favicon.ico' } ],
        [ 'meta', { name: 'apple-mobile-web-app-title', content: 'Ethereum Improvement Proposals' } ],
        [ 'meta', { name: 'application-name', content: 'Ethereum Improvement Proposals' } ],
        [ 'meta', { name: 'msapplication-TileColor', content: '#da532c' } ],
        [ 'meta', { name: 'msapplication-config', content: '/browserconfig.xml' } ],
        [ 'meta', { name: 'theme-color', content: '#ffffff' } ]
    ],
    appearance: true,
    titleTemplate: false,
    lastUpdated: true,
    async transformHead({ siteConfig, siteData, pageData, title, description, head, content }) {
        try { // Custom error handling needed because of the way VitePress handles errors (i.e. it doesn't)
            if (pageData.relativePath.match(/eip\/\w+\.md/)) {
                logger.info(`Generating Metadata for ${pageData.relativePath}`);
                
                let eip = pageData.relativePath.match(/eip\/(\w+)\.md/)[1];
                if (!eip) {
                    throw new Error(`EIP ${pageData.relativePath} not found`);
                }
                if (!(eip in config.eips)) {
                    throw new Error(`EIP ${eip} not found`);
                }
                let eipData = config.eips[eip];
                let frontmatter = eipData.data;

                console.log(JSON.stringify(frontmatter, null, 4));
    
                return [
                    // Regular Metadata
                    [ 'title', {}, frontmatter.title ]
                    [ 'meta', { name: 'description', content: pageData.description }],
                    [ 'link', { rel: 'canonical', href: `https://eips.ethereum.org/${pageData.relativePath}` } ],
                    ...frontmatter.author.map(author => [ 'meta', { name: 'author', content: author.name } ]),
                    [ 'meta', { name: 'date', content: frontmatter['created-slash'] } ],
                    [ 'meta', { name: 'copyright', content: 'CC0 1.0 Universal (Public Domain)' } ],
                    // Open Graph
                    [ 'meta', { property: 'og:title', content: frontmatter.title } ],
                    [ 'meta', { property: 'og:description', content: pageData.description } ],
                    [ 'meta', { property: 'og:url', content: `https://eips.ethereum.org/${pageData.relativePath}` } ],
                    [ 'meta', { property: 'og:locale', content: 'en_US' } ],
                    [ 'meta', { property: 'og:site_name', content: siteData.title } ],
                    [ 'meta', { property: 'og:type', content: 'article' } ],
                    // Twitter
                    [ 'meta', { name: 'twitter:card', content: 'summary' } ],
                    [ 'meta', { name: 'twitter:site_name', content: siteData.title } ],
                    [ 'meta', { name: 'twitter:site', content: '@ethereum' } ], // TODO: Replace with EIPs Twitter account, if one exists
                    [ 'meta', { name: 'twitter:description', content: pageData.description } ],
                    // Dublin Core
                    [ 'meta', { name: 'DC.title', content: frontmatter.title } ],
                    ...frontmatter.author.map(author => [ 'meta', { name: 'DC.creator', content: author.name } ]),
                    [ 'meta', { name: 'DC.date', content: frontmatter['created-slash'] } ],
                    frontmatter.finalized ? [ 'meta', { name: 'DC.issued', content: frontmatter['finalized-slash'] } ] : [],
                    [ 'meta', { name: 'DC.format', content: 'text/html' } ],
                    [ 'meta', { name: 'DC.language', content: 'en-US' } ],
                    [ 'meta', { name: 'DC.publisher', content: siteData.title } ],
                    [ 'meta', { name: 'DC.rights', content: 'CC0 1.0 Universal (Public Domain)' } ],
                    // Citation
                    [ 'meta', { name: 'citation_title', content: frontmatter.title } ],
                    ...frontmatter.author.map(author => [ 'meta', { name: 'citation_author', content: author.name } ]),
                    [ 'meta', { name: 'citation_online_date', content: frontmatter['created-slash'] } ],
                    frontmatter.finalized ? [ 'meta', { name: 'citation_publication_date', content: frontmatter['finalized-slash'] } ] : [],
                    [ 'meta', { name: 'citation_technical_report_institution', content: siteData.title } ],
                    [ 'meta', { name: 'citation_technical_report_number', content: frontmatter.eip } ],
                    // LD+JSON
                    [ 'script', { type: 'application/ld+json' }, JSON.stringify({
                        '@type': 'WebSite',
                        'url': `https://eips.ethereum.org/${pageData.relativePath}`,
                        'name': frontmatter.title,
                        'description': pageData.description,
                        '@context': 'https://schema.org'
                    })]
                ].filter(x => x?.length);
            } else {
                return [];
            }
        } catch (error) {
            logger.error(error);
            throw error;
        }
    },
    async transformPageData(pageData) {
        try { // Custom error handling needed because of the way VitePress handles runtime errors (i.e. it doesn't)
            logger.info(`Transforming ${pageData.relativePath}`, { timestamp: true });

            if (pageData.relativePath.match(/eips\/\w+\.md/)) {
                let eip = pageData.relativePath.match(/eip\/(\w+)\.md/)[1];
                if (!eip) {
                    throw new Error(`EIP ${pageData.relativePath} not found`);
                }
                if (!(eip in config.eips)) {
                    throw new Error(`EIP ${eip} not found`);
                }
                let eipData = config.eips[eip];
                let frontmatter = eipData.data;
                pageData.frontmatter = frontmatter;

                logger.info(`Transformed ${pageData.relativePath} (EIP)`, { timestamp: true });
                return pageData;
            } else if (pageData.frontmatter.listing) {
                pageData = { ...pageData };
                if (pageData.filter !== undefined) {
                    pageData.frontmatter.filteredEips = Object.values(config.eips).filter(eip => {
                        return Object.keys(pageData.frontmatter.filter).every(key => pageData.frontmatter.filter[key].includes(eip[key]));
                    }).map(eip => {
                        return {
                            eip: eip.eip,
                            title: eip.title,
                            status: eip.status,
                            authorData: eip.authorData,
                        };
                    });
                    logger.info(`Transformed ${pageData.relativePath} (listing page)`, { timestamp: true });
                }

                return pageData;
            } else {
                logger.info(`Transformed ${pageData.relativePath} (No special effects)`, { timestamp: true });

                return pageData;
            }
        } catch (e) {
            logger.error(`Error transforming ${pageData.relativePath}`, { timestamp: true });
            logger.error(e, { timestamp: true });
            throw e;
        }
    },
    async buildEnd(siteConfig) {
        logger.info('Making feeds');

        const url = 'https://eip.info';

        const feed = new Feed({
            title: siteConfig.site.title,
            description: siteConfig.site.description,
            link: `${url}/eips.atom`,
            language: 'en',
            image: `${url}/img/favicon-32x32.png`,
            favicon: `${url}/favicon.ico`,
            copyright: 'CC0 1.0 Universal (Public Domain)',
        });

        for (let eip in config.eips) {
            let fm = config.eips[eip].data;

            feed.addItem({
                title: fm.title,
                id: `${url}/EIPS/eip-${eip}`,
                link: `${url}/EIPS/eip-${eip}`,
                date: fm.lastStatusChange,
                description: fm.description,
                author: fm.authors.map(author => author.name),
                category: [
                    {
                        name: fm.category ?? fm.type,
                        term: fm.category ?? fm.type,
                        scheme: `${url}/category`,
                        domain: `${url}/category`
                    },
                    {
                        name: fm.status,
                        term: fm.status,
                        scheme: `${url}/status`,
                        domain: `${url}/status`
                    }
                ],
                content: config.eips[eip].content,
                guid: eip,
            });
        }

        // Export the feed
        await fs.writeFile(`./.vitepress/dist/eips.atom`, feed.atom1());
    },
    pwa: {
        injectRegister: 'script',
        workbox: {
            globPatterns: [] // Items to save to offline cache
        },
        manifest: {
            "name": "Ethereum Improvement Proposals",
            "short_name": "EIPs",
            "description": "Ethereum Improvement Proposals (EIPs) describe standards for the Ethereum platform, including core protocol specifications, client APIs, and contract standards.",
            "icons": [
                {
                    "src": "/img/android-chrome-192x192.png",
                    "sizes": "192x192",
                    "type": "image/png"
                },
                {
                    "src": "/img/android-chrome-512x512.png",
                    "sizes": "512x512",
                    "type": "image/png"
                }
            ],
            "theme_color": "#ffffff",
            "background_color": "#ffffff",
            "display": "standalone"
        }
    },
    mpa: true
}));
