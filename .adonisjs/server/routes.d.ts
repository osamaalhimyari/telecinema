import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'home': { paramsTuple?: []; params?: {} }
    'rooms.create': { paramsTuple?: []; params?: {} }
    'rooms.store': { paramsTuple?: []; params?: {} }
    'rooms.show': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'rooms.unlock': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'rooms.destroy': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'videos.stream': { paramsTuple: [ParamValue]; params: {'filename': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'new_account.store': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
    'session.store': { paramsTuple?: []; params?: {} }
    'session.destroy': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'home': { paramsTuple?: []; params?: {} }
    'rooms.create': { paramsTuple?: []; params?: {} }
    'rooms.show': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'videos.stream': { paramsTuple: [ParamValue]; params: {'filename': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
  }
  HEAD: {
    'home': { paramsTuple?: []; params?: {} }
    'rooms.create': { paramsTuple?: []; params?: {} }
    'rooms.show': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'videos.stream': { paramsTuple: [ParamValue]; params: {'filename': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
  }
  POST: {
    'rooms.store': { paramsTuple?: []; params?: {} }
    'rooms.unlock': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'rooms.destroy': { paramsTuple: [ParamValue]; params: {'slug': ParamValue} }
    'new_account.store': { paramsTuple?: []; params?: {} }
    'session.store': { paramsTuple?: []; params?: {} }
    'session.destroy': { paramsTuple?: []; params?: {} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}