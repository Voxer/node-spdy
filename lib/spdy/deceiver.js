'use strict'

// Vendored replacement for the npm `http-deceiver` package.
//
// The original package hijacks `socket.parser` (Node's HTTPParser instance,
// bound to llhttp internals) to synthesise an HTTP/1.1 message from SPDY/H2
// HEADERS frames. That approach broke on Node 16+ when
// `process.binding('http_parser')` was removed and llhttp's callback wiring
// shifted to Symbol-keyed slots, leading to wrong method dispatch and
// truncated/hung bodies.
//
// This implementation skips HTTPParser entirely and drives the public
// `http.IncomingMessage` / `http.ServerResponse` APIs directly. Body bytes
// reach the IncomingMessage via socket `'data'`/`'end'` events; spdy frames
// the response via `lib/spdy/response.js`, so ServerResponse never needs to
// emit HTTP/1.1 wire bytes.

var http = require('http')
var IncomingMessage = http.IncomingMessage
var ServerResponse = http.ServerResponse

function Deceiver (socket, options) {
  this.socket = socket
  this.options = options || {}
  this.isClient = this.options.isClient
  this.incoming = null
  this.clientReq = null
  this._detachedParser = false
  this._dataBound = false

  var self = this
  this._onData = function (chunk) {
    if (self.incoming) self.incoming.push(chunk)
  }
  this._onEnd = function () {
    if (self.incoming) {
      self.incoming.push(null)
      self.incoming.complete = true
    }
  }
}

module.exports = Deceiver

Deceiver.create = function create (socket, options) {
  return new Deceiver(socket, options)
}

Deceiver.prototype.setClientRequest = function setClientRequest (req) {
  this.clientReq = req
}

Deceiver.prototype._detachParser = function _detachParser () {
  if (this._detachedParser) return
  this._detachedParser = true
  var parser = this.socket.parser
  if (!parser) return
  parser.execute = function () { return 0 }
  parser.finish = function () { return 0 }
}

Deceiver.prototype._bindData = function _bindData () {
  if (this._dataBound) return
  this._dataBound = true
  this.socket.on('data', this._onData)
  this.socket.once('end', this._onEnd)
}

Deceiver.prototype._toRawHeaders = function _toRawHeaders (headers) {
  var raw = []
  var keys = Object.keys(headers)
  for (var i = 0; i < keys.length; i++) {
    raw.push(keys[i], String(headers[keys[i]]))
  }
  return raw
}

Deceiver.prototype.emitRequest = function emitRequest (request) {
  this._detachParser()

  var socket = this.socket
  var server = socket.server || (socket.parser && socket.parser.server)
  if (!server) throw new Error('spdy deceiver: no server on socket')

  var req = new IncomingMessage(socket)
  req.httpVersionMajor = 1
  req.httpVersionMinor = 1
  req.httpVersion = '1.1'
  req.method = request.method
  req.url = request.path
  req.headers = request.headers
  req.rawHeaders = this._toRawHeaders(request.headers)
  req.upgrade = false
  req.complete = false
  this.incoming = req

  var res = new ServerResponse(req)
  res.shouldKeepAlive = false
  res.assignSocket(socket)
  res.on('finish', function () { res.detachSocket(socket) })

  this._bindData()

  server.emit('request', req, res)
}

Deceiver.prototype.emitResponse = function emitResponse (response) {
  this._detachParser()

  var socket = this.socket
  var req = this.clientReq || socket._httpMessage
  if (!req) throw new Error('spdy deceiver: no clientReq for emitResponse')

  var res = new IncomingMessage(socket)
  res.httpVersionMajor = 1
  res.httpVersionMinor = 1
  res.httpVersion = '1.1'
  res.statusCode = response.status
  res.statusMessage = response.reason || ''
  res.headers = response.headers
  res.rawHeaders = this._toRawHeaders(response.headers)
  res.upgrade = false
  res.complete = false
  this.incoming = res

  this._bindData()

  req.res = res
  res.req = req
  req.emit('response', res)
}
