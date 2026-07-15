// 订单作废相关接口
import axios from 'axios'

/** 作废订单 */
export function voidOrder(id: string) {
  return axios.post('/api/order/void', { id })
}

/** 订单作废管理列表 */
export function getOrderVoidList(query: Record<string, unknown>) {
  return axios.get('/api/order/void/list', { params: query })
}
