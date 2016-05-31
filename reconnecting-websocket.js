// MIT License:
//
// Copyright (c) 2010-2012, Joe Walnes
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

(function () {
  function CustomEvent(event, params) {
    params = params || { bubbles: false, cancelable: false, detail: undefined };
    var evt = document.createEvent('CustomEvent');
    evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
    return evt;
  }

  CustomEvent.prototype = window.Event.prototype;
  window.CustomEvent = CustomEvent;
})();

/**
 * This behaves like a WebSocket in every way, except if it fails to connect,
 * or it gets disconnected, it will repeatedly poll until it successfully connects
 * again.
 *
 * It is API compatible, so when you have:
 *   ws = new WebSocket('ws://....');
 * you can replace with:
 *   ws = new ReconnectingWebSocket('ws://....');
 *
 * The event stream will typically look like:
 *  onconnecting
 *  onopen
 *  onmessage
 *  onmessage
 *  onclose // lost connection
 *  onconnecting
 *  onopen  // sometime later...
 *  onmessage
 *  onmessage
 *  etc...
 *
 * It is API compatible with the standard WebSocket API, apart from the following members:
 *
 * - `bufferedAmount`
 * - `extensions`
 * - `binaryType`
 *
 * Latest version: https://github.com/joewalnes/reconnecting-websocket/
 * - Joe Walnes
 *
 * Syntax
 * ======
 * var socket = new ReconnectingWebSocket(url, protocols, options);
 *
 * Parameters
 * ==========
 * url - The url you are connecting to.
 * protocols - Optional string or array of protocols.
 * options - See below
 *
 * Options
 * =======
 * Options can either be passed upon instantiation or set after instantiation:
 *
 * var socket = new ReconnectingWebSocket(url, null, { debug: true, reconnectInterval: 4000 });
 *
 * or
 *
 * var socket = new ReconnectingWebSocket(url);
 * socket.debug = true;
 * socket.reconnectInterval = 4000;
 *
 * debug
 * - Whether this instance should log debug messages. Accepts true or false. Default: false.
 *
 * automaticOpen
 * - Whether or not the websocket should attempt to connect immediately upon instantiation. The socket can be manually opened or closed at any time using ws.open() and ws.close().
 *
 * reconnectInterval
 * - The number of milliseconds to delay before attempting to reconnect. Accepts integer. Default: 1000.
 *
 * maxReconnectInterval
 * - The maximum number of milliseconds to delay a reconnection attempt. Accepts integer. Default: 30000.
 *
 * reconnectDecay
 * - The rate of increase of the reconnect delay. Allows reconnect attempts to back off when problems persist. Accepts integer or float. Default: 1.5.
 *
 * timeoutInterval
 * - The maximum time in milliseconds to wait for a connection to succeed before closing and retrying. Accepts integer. Default: 2000.
 *
 */
(function (global, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module !== 'undefined' && module.exports){
    module.exports = factory();
  } else {
    global.ReconnectingWebSocket = factory();
  }
})(this, function () {
  if (!('WebSocket' in window)) {
    return;
  }

  function ReconnectingWebSocket(url, protocols, options) {
    // Default settings
    var settings = {
      /** Whether this instance should log debug messages. */
      debug: false,

      /** Whether or not the websocket should attempt to connect immediately upon instantiation. */
      automaticOpen: true,

      /** The number of milliseconds to delay before attempting to reconnect. */
      reconnectInterval: 1000,
      /** The maximum number of milliseconds to delay a reconnection attempt. */
      maxReconnectInterval: 30000,
      /** The rate of increase of the reconnect delay. Allows reconnect attempts to back off when problems persist. */
      reconnectDecay: 1.5,

      /** The maximum time in milliseconds to wait for a connection to succeed before closing and retrying. */
      timeoutInterval: 2000,

      /** The maximum number of reconnection attempts to make. Unlimited if null. */
      maxReconnectAttempts: null,

      /** The binary type, possible values 'blob' or 'arraybuffer', default 'blob'. */
      binaryType: 'blob'
    }
    if (!options) {
      options = {};
    }

    // Overwrite and define settings with options if they exist.
    for (var key in settings) {
      if (typeof options[key] !== 'undefined') {
        this[key] = options[key];
      } else {
        this[key] = settings[key];
      }
    }

    // These should be treated as read-only properties

    /** The URL as resolved by the constructor. This is always an absolute URL. Read only. */
    this.url = url;

    /** The number of attempted reconnects since starting, or the last successful connection. Read only. */
    this.reconnectAttempts = 0;

    /**
     * The current state of the connection.
     * Can be one of: WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED
     * Read only.
     */
    this.readyState = WebSocket.CONNECTING;

    /**
     * A string indicating the name of the sub-protocol the server selected; this will be one of
     * the strings specified in the protocols parameter when creating the WebSocket object.
     * Read only.
     */
    this.protocol = null;

    // Private state variables

    var self = this;
    var ws;
    var forcedClose = false;
    var timedOut = false;
    var eventTarget = document.createElement('div');

    // Wire up "on*" properties as event handlers

    eventTarget.addEventListener('open', function (event) {
      self.onopen(event);
    });
    eventTarget.addEventListener('close', function (event) {
      self.onclose(event);
    });
    eventTarget.addEventListener('connecting', function (event) {
      self.onconnecting(event);
    });
    eventTarget.addEventListener('message', function (event) {
      self.onmessage(event);
    });
    eventTarget.addEventListener('error', function (event) {
      self.onerror(event);
    });

    // Expose the API required by EventTarget

    this.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    this.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    this.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);

    this.open = function (reconnectAttempt) {
      ws = new WebSocket(self.url, protocols || []);
      ws.binaryType = this.binaryType;

      if (reconnectAttempt) {
        if (this.maxReconnectAttempts && this.reconnectAttempts > this.maxReconnectAttempts) {
          return;
        }
      } else {
        eventTarget.dispatchEvent(new CustomEvent('connecting'));
        this.reconnectAttempts = 0;
      }

      if (self.debug || ReconnectingWebSocket.debugAll) {
        console.debug('ReconnectingWebSocket', 'attempt-connect', self.url);
      }

      var localWs = ws;
      var timeout = setTimeout(function() {
        if (self.debug || ReconnectingWebSocket.debugAll) {
          console.debug('ReconnectingWebSocket', 'connection-timeout', self.url);
        }
        
        timedOut = true;
        localWs.close();
        timedOut = false;
      }, self.timeoutInterval);

      ws.onopen = function (event) {
        clearTimeout(timeout);
        if (self.debug || ReconnectingWebSocket.debugAll) {
          console.debug('ReconnectingWebSocket', 'onopen', self.url, event);
        }

        self.protocol = ws.protocol;
        self.readyState = WebSocket.OPEN;
        self.reconnectAttempts = 0;

        eventTarget.dispatchEvent(new CustomEvent('open', {
          detail: {
            isReconnect: reconnectAttempt
          }
        }));

        reconnectAttempt = false;
      };

      ws.onclose = function (event) {
        clearTimeout(timeout);
        ws = null;
        if (forcedClose) {
          self.readyState = WebSocket.CLOSED;

          eventTarget.dispatchEvent(new CustomEvent('close', {
            detail: {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean
            }
          }));
        } else {
          self.readyState = WebSocket.CONNECTING;

          eventTarget.dispatchEvent(new CustomEvent('connecting', {
            detail: {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean
            }
          }));
          if (!reconnectAttempt && !timedOut) {
            if (self.debug || ReconnectingWebSocket.debugAll) {
              console.debug('ReconnectingWebSocket', 'onclose', self.url, event);
            }

            eventTarget.dispatchEvent(new CustomEvent('close', {
              detail: {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean
              }
            }));
          }

          var timeout = self.reconnectInterval * Math.pow(self.reconnectDecay, self.reconnectAttempts);
          setTimeout(function() {
            self.reconnectAttempts++;
            self.open(true);
          }, timeout > self.maxReconnectInterval ? self.maxReconnectInterval : timeout);
        }
      };
      ws.onmessage = function (event) {
        if (self.debug || ReconnectingWebSocket.debugAll) {
          console.debug('ReconnectingWebSocket', 'onmessage', self.url, event);
        }

        eventTarget.dispatchEvent(new CustomEvent('message', {
          detail: {
            data: event.data
          }
        }));
      };
      ws.onerror = function (event) {
        if (self.debug || ReconnectingWebSocket.debugAll) {
          console.debug('ReconnectingWebSocket', 'onerror', self.url, event);
        }

        eventTarget.dispatchEvent(new CustomEvent('error'));
      };
    }

    // Whether or not to create a websocket upon instantiation
    if (this.automaticOpen == true) {
      this.open(false);
    }

    /**
     * Transmits data to the server over the WebSocket connection.
     *
     * @param data a text string, ArrayBuffer or Blob to send to the server.
     */
    this.send = function (data) {
      if (ws) {
        if (self.debug || ReconnectingWebSocket.debugAll) {
          console.debug('ReconnectingWebSocket', 'send', self.url, data);
        }
        return ws.send(data);
      } else {
        throw 'INVALID_STATE_ERR : Pausing to reconnect websocket';
      }
    };

    /**
     * Closes the WebSocket connection or connection attempt, if any.
     * If the connection is already CLOSED, this method does nothing.
     */
    this.close = function (code, reason) {
      // Default CLOSE_NORMAL code
      if (typeof code == 'undefined') {
        code = 1000;
      }
      forcedClose = true;
      if (ws) {
        ws.close(code, reason);
      }
    };

    /**
     * Additional public API method to refresh the connection if still open (close, re-open).
     * For example, if the app suspects bad data / missed heart beats, it can try to refresh.
     */
    this.refresh = function () {
      if (ws) {
        ws.close();
      }
    };
  }

  /**
   * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
   * this indicates that the connection is ready to send and receive data.
   */
  ReconnectingWebSocket.prototype.onopen = function (event) {};
  /** An event listener to be called when the WebSocket connection's readyState changes to CLOSED. */
  ReconnectingWebSocket.prototype.onclose = function (event) {};
  /** An event listener to be called when a connection begins being attempted. */
  ReconnectingWebSocket.prototype.onconnecting = function (event) {};
  /** An event listener to be called when a message is received from the server. */
  ReconnectingWebSocket.prototype.onmessage = function (event) {};
  /** An event listener to be called when an error occurs. */
  ReconnectingWebSocket.prototype.onerror = function (event) {};

  /**
   * Whether all instances of ReconnectingWebSocket should log debug messages.
   * Setting this to true is the equivalent of setting all instances of ReconnectingWebSocket.debug to true.
   */
  ReconnectingWebSocket.debugAll = false;

  ReconnectingWebSocket.CONNECTING = WebSocket.CONNECTING;
  ReconnectingWebSocket.OPEN = WebSocket.OPEN;
  ReconnectingWebSocket.CLOSING = WebSocket.CLOSING;
  ReconnectingWebSocket.CLOSED = WebSocket.CLOSED;

  return ReconnectingWebSocket;
});
