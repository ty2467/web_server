import { Routes } from '@angular/router';
import { IngestComponent } from './ingest/ingest.component';
import { DashboardComponent } from './dashboard/dashboard.component';

export const routes: Routes = [

  // { path: 'login', component: LoginComponent },
  { path: 'ingest', component: IngestComponent },
  { path: 'dashboard', component: DashboardComponent },
  { path: '', redirectTo: '/ingest', pathMatch: 'full' } // Default to login
];
