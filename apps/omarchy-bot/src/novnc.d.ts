declare module "@novnc/novnc" {
  export interface RFBOptions {
    viewOnly?: boolean;
    scaleViewport?: boolean;
    clipViewport?: boolean;
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, urlOrChannel: string | WebSocket, options?: RFBOptions);
    disconnect(): void;
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    showDotCursor: boolean;
  }
}
