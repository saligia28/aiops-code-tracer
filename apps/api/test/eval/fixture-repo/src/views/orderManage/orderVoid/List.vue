<template>
  <div class="order-void-list">
    <!-- 订单作废管理列表页 -->
    <h2>订单作废管理</h2>
    <CommonTable :fetchTableData="getTableData">
      <el-button v-if="row.status === 2" @click="handleVoid(row)">作废</el-button>
      <el-button @click="handleDetail(row)">查看</el-button>
    </CommonTable>
  </div>
</template>

<script>
import { voidOrder, getOrderVoidList } from '@/api/orderVoid'

export default {
  name: 'OrderVoidList',
  data() {
    return {
      tableData: [],
      // 作废状态：0=草稿 1=已提交 2=已审核（仅已审核可作废）
      voidableStatus: 2,
    }
  },
  methods: {
    getTableData(query) {
      return getOrderVoidList(query).then((res) => {
        this.tableData = res.list || []
      })
    },
    // 作废订单：二次确认后调接口
    handleVoid(row) {
      if (row.status !== this.voidableStatus) return
      return voidOrder(row.id).then(() => this.getTableData({}))
    },
    handleDetail(row) {
      this.$router.push(`/orderManage/orderVoid/detail?id=${row.id}`)
    },
  },
}
</script>
