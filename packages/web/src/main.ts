import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Overview from './views/Overview.vue';
import BoreholeForm from './views/BoreholeForm.vue';
import BoreholeDetail from './views/BoreholeDetail.vue';
import UploadMeasurement from './views/UploadMeasurement.vue';
import MeasurementDetailView from './views/MeasurementDetailView.vue';
import Probes from './views/Probes.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Overview },
    { path: '/boreholes/new', component: BoreholeForm },
    { path: '/boreholes/:code', component: BoreholeDetail, props: true },
    { path: '/boreholes/:code/upload', component: UploadMeasurement, props: true },
    { path: '/measurements/:id', component: MeasurementDetailView, props: true },
    { path: '/probes', component: Probes },
  ],
});

createApp(App).use(router).mount('#app');
