'use strict';

const EventEmitter = require("events");
const os = require('os');
const http = require('http');
const cheerio = require('cheerio');
const request = require('request');
const ytdl = require('ytdl-core');
const SsdpClient = require("node-ssdp").Client;
const MediaRendererClient = require('upnp-mediarenderer-client');
// constants
const source = process.argv[2];

class Devices extends SsdpClient {

    constructor(label) {
        super();
        this.updateInterval = 60;
        this.updateTimer = null;
        this.LOCK = false;
        this.on('response', (headers) => {
            if(!this.LOCK && headers.SERVER.indexOf(label) !== -1) {
                // console.log('Device:', headers.SERVER, headers.LOCATION);
                this.LOCK = true;
                clearTimeout(this.updateTimer);
                this.updateInterval = 0;
                this.emit('ready', headers.LOCATION, headers.SERVER);
            }
        });
        console.log(`Discovering device "${label}"...`);
        this.sendDiscover();
    }

    sendDiscover() {
        // this.search('urn:schemas-upnp-org:device:MediaServer:1');
        this.search('urn:schemas-upnp-org:device:MediaRenderer:1');
        if(this.updateInterval > 0)
            this.updateTimer = setTimeout(this.sendDiscover, this.updateInterval);
    }
}

class DLNAServer {
    constructor(port = 9999, ip) {
        this.video = null;
        this.playlist = [];
        this.server = http.createServer();
        this.server.setTimeout(0);
        this.server.on('request', (req, res) => this.request(req, res));
        if(!ip) ip = this.getIP();
        this.url = `http://${ip}:${port}/video.mp4`;
        this.server.listen(port, ip,() => {
            console.log(`Started DLNA server on ${ip}:${port}`);
        });
    }

    async request(req, res) {
        // console.log('[streamserver]', req.headers['range'], this.video.total);
        if(!this.video) throw Error('Video is not found');
        if (req.headers['range']) {
            const range = req.headers.range;
            const [start,end] = range.replace(/bytes=/, "").split("-");
            const lost = await this.video.seek(start);
            res.writeHead(206, {
                'Content-Range': 'bytes ' + start + '-' + (end || this.video.total) + '/' + this.video.total,
                'Accept-Ranges': 'bytes',
                'Content-Length': lost,
                'Content-Type': this.video.mime,
                "transferMode.dlna.org": "Streaming",
                "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000",
                // "CaptionInfo.sec": localUrl
            });
            this.video.pipe(res);
        } else {
            res.writeHead(201, {
                'Content-Length': this.video.total,
                'Content-Type': this.video.mime,
                "transferMode.dlna.org": "Streaming",
                "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000",
                // "CaptionInfo.sec": localUrl
            });
            res.end();
        }
    }

    async play(source, options) {
        if(source.indexOf('playlist') !== -1) {
            this.playlist = await playlist(source);
            console.log(`Playlist loaded with ${this.playlist.length} items`);
            source = this.playlist.shift();
        }
        const video = new StreamVideo(source, options);
        await video.load();
        this.video = video;
        return video;
    }

    getIP(family = 'IPv4') {
        const interfaces = os.networkInterfaces();
        for (const i in interfaces) {
            for (let j = interfaces[i].length - 1; j >= 0; j--) {
                const face = interfaces[i][j];
                const reachable = family === 'IPv4' || face.scopeid === 0;
                if (!face.internal && face.family === family && reachable) return face.address;
            }
        }
        return family === 'IPv4' ? '127.0.0.1' : '::1';
    }

    destroy() {
        this.video.destroy();
        this.video.removeAllListeners();
        this.server.close();
        this.server.removeAllListeners();
        this.server = null;
        this.video = null;
    }
}

class StreamVideo extends EventEmitter {
    constructor(source, options = {}) {
        super();
        this.source = source;
        this.id = null;
        this.meta = {
            title: null,
            creator: null,
        };
        this.mime = null;
        this.total = null;
        this.url = null;
        this.stream = null;
        this.format = options.format || 22;
        this.range = options.range || {start:0};
        // this.percent = 0;
    }

    load(source, range) {
        return new Promise(resolve => {
            this.destroy();
            this.stream = ytdl(source || this.source, {
                // highWaterMark: 10 * 1024 * 1024,
                format: this.format,
                range: range || this.range
            });
            this.stream.once('response', (res) => {
                if(!range) {
                    this.total = res.headers['content-length'];
                    this.mime = res.headers['content-type'];
                }
            });
            this.stream.once('info', (info, format) => {
                if(!range) {
                    this.id = info.video_id;
                    this.url = format.url;
                    this.meta = {
                        title: info.title,
                        creator: info.author.name
                    };
                }
            });
            this.stream.on('progress', (chunkLength, downloaded, total) => {
                // console.log({chunkLength, downloaded, total});
                // console.log(this.stream.readableLength, '/', this.stream.readableHighWaterMark);
                // if(!range) this.total = total;
                // const percent = downloaded / total * 100;
                // if(this.percent < Math.ceil(percent)) {
                //     console.log(`${percent.toFixed(2)}% downloaded`);
                //     console.log(`(${(downloaded / 1024 / 1024).toFixed(2)}MB of ${(total / 1024 / 1024).toFixed(2)}MB)\n`);
                //     this.percent = Math.ceil(percent);
                // }
                if(this.stream.readableLength >= this.stream.readableHighWaterMark) return resolve(this.id);
            });
        });
    }

    async seek(start) {
        await this.load(this.source, {start});
        return this.total - start;
    }

    pipe(res) {
        return this.stream.pipe(res);
    }

    destroy() {
        if(this.stream) {
            this.stream.destroy();
            this.stream.removeAllListeners();
        }
    }

}

const dlna = new DLNAServer();
const device = new Devices('Samsung');
device.on('ready', async (location, label) => {
    console.log('Loading video', source, '...');
    const {mime, meta} = await dlna.play(source);
    console.log('Connecting to device', label, location, '...');
    const client = new MediaRendererClient(location);
    const options = {
        autoplay: true,
        contentType: mime,
        metadata: {
            ...meta,
            type: 'video',
            // subtitlesUrl: 'http://url.to.some/subtitles.srt'
        }
    };
    // console.log(dlna.url, options);
    client.load(dlna.url, options, (err) => {
        if(err) throw err;
        console.log('Send video...');
    });

    // client.on('status', (status) => console.log({status}));

    client.on('loading', () => console.log('Buffering...'));

    client.on('playing', function() {
        console.log('Playing');
        // client.getPosition(function(err, position) {
        //     console.log(position); // Current position in seconds
        // });
        //
        // client.getDuration(function(err, duration) {
        //     console.log(duration); // Media duration in seconds
        // });
    });

    client.on('paused', () => console.log('Paused'));

    client.on('stopped', async () => {
        console.log('Stopped');
        // dlna.destroy();
        if(dlna.playlist.length) {
            const video = dlna.playlist.shift();
            console.log('Loading video', video, '...');
            const {mime, meta} = await dlna.play(video);
            const options = {
                autoplay: true,
                contentType: mime,
                metadata: {
                    ...meta,
                    type: 'video',
                    // subtitlesUrl: 'http://url.to.some/subtitles.srt'
                }
            };
            // console.log(dlna.url, options);
            client.load(dlna.url, options, (err) => {
                if(err) throw err;
                console.log('Send video...');
            });
        } else {
            dlna.destroy();
            console.log('End');
        }
    });

    client.on('speedChanged', (speed) => console.log('speedChanged', speed));
});


function playlist(url) {
    return new Promise((resolve, reject) => {
        request(url, (err, res, html) => {
            if(err) return reject(err);
            let $ = cheerio.load(html),
                videos = $('tr[data-video-id]'),
                idVideos = [];
            for (let vid in videos) {
                if (videos.hasOwnProperty(vid) && videos[vid].attribs)
                    idVideos.push(videos[vid].attribs['data-video-id']);
            }
            resolve(idVideos);
        })
    });
}
