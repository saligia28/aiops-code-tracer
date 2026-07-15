// 备料核料相关接口
import axios from 'axios'

/** 备料核料列表 */
export function getStockCheckList(query: Record<string, unknown>) {
  return axios.get('/api/stock/check/list', { params: query })
}

/** 核料确认 */
export function confirmStockCheck(id: string) {
  return axios.post('/api/stock/check/confirm', { id })
}
