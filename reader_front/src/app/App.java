import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink], // Add RouterLink if you add a nav menu
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App {}
