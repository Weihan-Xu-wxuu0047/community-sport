<template>
  <div class="container py-4 py-lg-5">
    <div class="row">
      <div class="col-12">
        <!-- Header -->
        <div class="d-flex justify-content-between align-items-center mb-4">
          <div>
            <h1 class="h3 mb-1">Organizer Dashboard</h1>
            <p class="text-muted mb-0">Manage and create sports programs for your community</p>
          </div>
          <div class="d-flex gap-2">
            <RoleSwitcher />
            <button @click="handleLogout" class="btn btn-outline-secondary">
              <i class="bi bi-box-arrow-right me-2" aria-hidden="true"></i>
              Logout
            </button>
          </div>
        </div>

        <!-- My Account Component -->
        <MyAccount />

        <!-- Launch Programs Section -->
        <div class="card mb-4">
          <div class="card-header bg-success text-white">
            <h5 class="card-title mb-0">
              <i class="bi bi-plus-circle me-2" aria-hidden="true"></i>
              Program Management
            </h5>
          </div>
          <div class="card-body">
            <div class="row align-items-center">
              <div class="col-md-8">
                <h6 class="mb-2">Ready to create a new program?</h6>
                <p class="text-muted mb-md-0">
                  Launch new sports programs and events to engage your community. 
                  Set schedules, manage registrations, and track participation.
                </p>
              </div>
              <div class="col-md-4 text-md-end">
                <RouterLink :to="{ name: 'launch-program' }" class="btn btn-success btn-lg">
                  <i class="bi bi-rocket-takeoff me-2" aria-hidden="true"></i>
                  Launch Programs
                </RouterLink>
              </div>
            </div>
          </div>
        </div>

        <!-- My Programs Overview -->
        <div class="card mb-4">
          <div class="card-header bg-light">
            <div class="d-flex justify-content-between align-items-center">
            <h5 class="card-title mb-0">
              <i class="bi bi-list-check me-2" aria-hidden="true"></i>
              My Programs
            </h5>
               <button 
                 @click="exportToPDF" 
                 class="btn btn-outline-primary btn-sm"
                 :disabled="isExporting || activePrograms.length === 0"
               >
                 <span v-if="isExporting" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                 <i v-else class="bi bi-file-earmark-pdf me-2" aria-hidden="true"></i>
                 {{ isExporting ? 'Exporting...' : 'Export PDF' }}
               </button>
            </div>
          </div>
          <div class="card-body">
            <!-- Loading State -->
            <div v-if="programsLoading" class="text-center py-5">
              <div class="spinner-border text-primary mb-3" role="status">
                <span class="visually-hidden">Loading programs...</span>
              </div>
              <p class="text-muted">Loading your programs...</p>
            </div>

            <!-- Error State -->
            <div v-else-if="programsError" class="alert alert-danger" role="alert">
              <i class="bi bi-exclamation-triangle me-2"></i>
              {{ programsError }}
              <button @click="loadMyPrograms" class="btn btn-outline-danger btn-sm ms-2">
                Try Again
              </button>
            </div>

            <!-- Empty State -->
            <div v-else-if="activePrograms.length === 0 && cancelledPrograms.length === 0" class="text-center py-5">
              <i class="bi bi-clipboard-data display-4 text-muted mb-3" aria-hidden="true"></i>
              <h6 class="text-muted mb-3">No Programs Created Yet</h6>
              <p class="text-muted mb-4">
                You haven't created any programs yet. Start by launching your first program!
              </p>
              <RouterLink :to="{ name: 'launch-program' }" class="btn btn-outline-success">
                <i class="bi bi-plus-circle me-2" aria-hidden="true"></i>
                Create Your First Program
              </RouterLink>
            </div>
            
            <!-- Active Programs List -->
            <div v-else>
              <div v-if="activePrograms.length > 0" class="row g-4">
                <div v-for="program in activePrograms" :key="program.id" class="col-md-6 col-lg-4">
                  <div class="card h-100 border-0 shadow-sm">
                    <div class="card-header bg-light border-0">
                      <div class="d-flex justify-content-between align-items-start">
                        <div>
                          <h6 class="card-title mb-1">{{ program.title }}</h6>
                          <small class="text-muted">{{ program.sport }}</small>
                        </div>
                        <span class="badge bg-success">Active</span>
                      </div>
                    </div>
                    <div class="card-body">
                      <p class="card-text text-muted small mb-3">
                        {{ program.description.length > 100 ? program.description.substring(0, 100) + '...' : program.description }}
                      </p>
                      
                      <div class="mb-3">
                        <div class="d-flex align-items-center mb-2">
                          <i class="bi bi-geo-alt text-muted me-2"></i>
                          <small class="text-muted">{{ program.venue?.name || 'Venue TBD' }}</small>
                        </div>
                        <div class="d-flex align-items-center mb-2">
                          <i class="bi bi-people text-muted me-2"></i>
                          <small class="text-muted">Max {{ program.maxParticipants }} participants</small>
                        </div>
                        <div class="d-flex align-items-center">
                          <i class="bi bi-currency-dollar text-muted me-2"></i>
                          <small class="text-muted">
                            {{ program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit}` }}
                          </small>
                        </div>
                      </div>

                      <div class="mb-3">
                        <small class="text-muted d-block">Schedule:</small>
                        <div v-for="schedule in program.schedule.slice(0, 2)" :key="schedule.day" class="small text-muted">
                          {{ schedule.day }}s: {{ schedule.start }} - {{ schedule.end }}
                        </div>
                        <small v-if="program.schedule.length > 2" class="text-muted">
                          +{{ program.schedule.length - 2 }} more days
                        </small>
                      </div>
                    </div>
                    <div class="card-footer bg-transparent border-0">
                      <div class="d-flex gap-2">
                        <RouterLink 
                          :to="{ name: 'edit-program', params: { id: program.id } }" 
                          class="btn btn-primary btn-sm flex-fill"
                        >
                          <i class="bi bi-pencil me-1"></i>
                          Edit
                        </RouterLink>
                        <button 
                          @click="viewProgramDetails(program)" 
                          class="btn btn-outline-secondary btn-sm"
                        >
                          <i class="bi bi-eye"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty Active Programs State -->
              <div v-if="activePrograms.length === 0 && cancelledPrograms.length > 0" class="text-center py-4">
                <i class="bi bi-clipboard-data display-4 text-muted mb-3" aria-hidden="true"></i>
                <h6 class="text-muted mb-3">No Active Programs</h6>
                <p class="text-muted mb-4">
                  You don't have any active programs at the moment. Create a new program or check your archived programs below.
                </p>
                <RouterLink :to="{ name: 'launch-program' }" class="btn btn-outline-success">
                  <i class="bi bi-plus-circle me-2" aria-hidden="true"></i>
                  Create New Program
                </RouterLink>
              </div>

              <!-- Archive Section -->
              <div v-if="cancelledPrograms.length > 0" class="mt-5">
                <div class="d-flex align-items-center mb-3">
                  <button 
                    @click="toggleArchive" 
                    class="btn btn-outline-secondary btn-sm me-3"
                    :class="{ 'collapsed': !showArchive }"
                    type="button"
                    data-bs-toggle="collapse"
                    :data-bs-target="'#archiveCollapse'"
                    :aria-expanded="showArchive"
                    aria-controls="archiveCollapse"
                  >
                    <i class="bi" :class="showArchive ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
                  </button>
                  <h6 class="mb-0 text-muted">
                    <i class="bi bi-archive me-2"></i>
                    Cancelled Programs ({{ cancelledPrograms.length }})
                  </h6>
                </div>
                
                <div class="collapse" :class="{ 'show': showArchive }" id="archiveCollapse">
                  <div class="row g-4">
                    <div v-for="program in cancelledPrograms" :key="program.id" class="col-md-6 col-lg-4">
                      <div class="card h-100 border-0 shadow-sm archive-card">
                        <div class="card-header bg-light border-0">
                          <div class="d-flex justify-content-between align-items-start">
                            <div>
                              <h6 class="card-title mb-1">{{ program.title }}</h6>
                              <small class="text-muted">{{ program.sport }}</small>
                            </div>
                            <span class="badge bg-danger">Cancelled</span>
                          </div>
                        </div>
                        <div class="card-body">
                          <p class="card-text text-muted small mb-3">
                            {{ program.description.length > 100 ? program.description.substring(0, 100) + '...' : program.description }}
                          </p>
                          
                          <div class="mb-3">
                            <div class="d-flex align-items-center mb-2">
                              <i class="bi bi-geo-alt text-muted me-2"></i>
                              <small class="text-muted">{{ program.venue?.name || 'Venue TBD' }}</small>
                            </div>
                            <div class="d-flex align-items-center mb-2">
                              <i class="bi bi-people text-muted me-2"></i>
                              <small class="text-muted">Max {{ program.maxParticipants }} participants</small>
                            </div>
                            <div class="d-flex align-items-center">
                              <i class="bi bi-currency-dollar text-muted me-2"></i>
                              <small class="text-muted">
                                {{ program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit}` }}
                              </small>
                            </div>
                          </div>

                          <div class="mb-3">
                            <small class="text-muted d-block">Schedule:</small>
                            <div v-for="schedule in program.schedule.slice(0, 2)" :key="schedule.day" class="small text-muted">
                              {{ schedule.day }}s: {{ schedule.start }} - {{ schedule.end }}
                            </div>
                            <small v-if="program.schedule.length > 2" class="text-muted">
                              +{{ program.schedule.length - 2 }} more days
                            </small>
                          </div>

                          <div v-if="program.cancelled_at" class="mb-3">
                            <small class="text-muted d-block">Cancelled:</small>
                            <small class="text-muted">{{ formatDate(program.cancelled_at) }}</small>
                          </div>
                        </div>
                        <div class="card-footer bg-transparent border-0">
                          <div class="d-flex gap-2">
                            <button 
                              @click="viewProgramDetails(program)" 
                              class="btn btn-outline-secondary btn-sm flex-fill"
                            >
                              <i class="bi bi-eye me-1"></i>
                              View Details
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="row g-4">
          <div class="col-md-3">
            <div class="card h-100 border-0 bg-light">
              <div class="card-body text-center">
                <i class="bi bi-people text-primary mb-3" style="font-size: 2rem;" aria-hidden="true"></i>
                <h6 class="card-title">Participants</h6>
                <p class="card-text text-muted small">Manage registrations and participant communications</p>
                <button class="btn btn-outline-primary btn-sm" disabled>
                  Coming Soon
                </button>
              </div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card h-100 border-0 bg-light">
              <div class="card-body text-center">
                <i class="bi bi-bar-chart text-primary mb-3" style="font-size: 2rem;" aria-hidden="true"></i>
                <h6 class="card-title">Analytics</h6>
                <p class="card-text text-muted small">View program performance and engagement metrics</p>
                <button class="btn btn-outline-primary btn-sm" disabled>
                  Coming Soon
                </button>
              </div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card h-100 border-0 bg-light">
              <div class="card-body text-center">
                <i class="bi bi-calendar-week text-primary mb-3" style="font-size: 2rem;" aria-hidden="true"></i>
                <h6 class="card-title">Schedule</h6>
                <p class="card-text text-muted small">Manage program schedules and venue bookings</p>
                <button class="btn btn-outline-primary btn-sm" disabled>
                  Coming Soon
                </button>
              </div>
            </div>
          </div>
          <div v-if="!hasMemberRole" class="col-md-3">
            <div class="card h-100 border-0 bg-primary text-white">
              <div class="card-body text-center">
                <i class="bi bi-person text-white mb-3" style="font-size: 2rem;" aria-hidden="true"></i>
                <h6 class="card-title">Join Programs</h6>
                <p class="card-text small">Participate in community sports programs</p>
                <RouterLink :to="{ name: 'register' }" class="btn btn-light btn-sm">
                  Add Member Role
                </RouterLink>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import authService from '../../services/AuthService.js';
import dataService from '../../services/DataService.js';
import MyAccount from '../MyAccount.vue';
import RoleSwitcher from '../RoleSwitcher.vue';

const router = useRouter();

// Check if user has member role
const currentUser = ref({ user: null, role: null, availableRoles: [] });
const hasMemberRole = computed(() => {
  const availableRoles = currentUser.value.availableRoles || [];
  return availableRoles.includes('member');
});

// Program management state
const myPrograms = ref([]);
const programsLoading = ref(false);
const programsError = ref(null);

// Export state
const isExporting = ref(false);

// Archive state
const showArchive = ref(false);

// Computed properties for program filtering
const activePrograms = computed(() => {
  return myPrograms.value.filter(program => program.status !== 'cancelled');
});

const cancelledPrograms = computed(() => {
  return myPrograms.value.filter(program => program.status === 'cancelled');
});

// Load user programs
async function loadMyPrograms() {
  if (!currentUser.value.user?.email) return;
  
  try {
    programsLoading.value = true;
    programsError.value = null;
    
    // Get all programs and filter by organizer email
    const allPrograms = await dataService.getPrograms();
    myPrograms.value = allPrograms.filter(program => 
      program.organizer_email === currentUser.value.user.email
    );
    
    console.log(`Loaded ${myPrograms.value.length} programs for organizer`);
  } catch (error) {
    console.error('Error loading organizer programs:', error);
    programsError.value = 'Failed to load your programs. Please try again.';
  } finally {
    programsLoading.value = false;
  }
}

// Load user data on mount
onMounted(async () => {
  const userData = await authService.getCurrentUser();
  currentUser.value = userData;
  
  if (userData.user) {
    await loadMyPrograms();
  }
});

// Listen for auth state changes
const unsubscribe = authService.onAuthStateChange(async (user, role) => {
  if (user) {
    const userData = await authService.getCurrentUser();
    currentUser.value = userData;
  } else {
    currentUser.value = { user: null, role: null, availableRoles: [] };
  }
});

// Cleanup on unmount
onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe();
  }
});

// Toggle archive visibility
function toggleArchive() {
  showArchive.value = !showArchive.value;
}

// Format date for display
function formatDate(date) {
  if (!date) return 'Unknown';
  
  try {
    // Handle Firestore timestamp
    if (date.toDate) {
      return date.toDate().toLocaleDateString();
    }
    // Handle regular date string
    return new Date(date).toLocaleDateString();
  } catch (error) {
    console.error('Error formatting date:', error);
    return 'Invalid date';
  }
}

// View program details
function viewProgramDetails(program) {
  router.push({ name: 'program', params: { id: program.id } });
}

// Handle logout
async function handleLogout() {
  try {
    await authService.logout();
    router.push({ name: 'home' });
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// Export to PDF
async function exportToPDF() {
  if (!currentUser.value.user?.email || activePrograms.value.length === 0) {
    return;
  }

  try {
    isExporting.value = true;
    
    // Call the Cloud Function to generate PDF
    const result = await dataService.generateOrganizerReport({
      organizerEmail: currentUser.value.user.email,
      includeCancelled: false // Only active programs for now
    });

             if (result.success && result.pdfUrl) {
               // Create a direct download link for PDF
               const link = document.createElement('a');
               link.href = result.pdfUrl;
               link.download = `organizer-report-${new Date().toISOString().split('T')[0]}.pdf`;
               link.target = '_blank';
               
               // Add the link to the page temporarily
               document.body.appendChild(link);
               link.click();
               document.body.removeChild(link);
               
               console.log('PDF report download initiated');
               
               // Show success message
               programsError.value = '';
               alert('PDF report download started! If it doesn\'t download automatically, the file will open in a new tab.');
             } else {
               throw new Error(result.message || 'Failed to generate report');
             }
  } catch (error) {
    console.error('Export error:', error);
    programsError.value = `Export failed: ${error.message}`;
  } finally {
    isExporting.value = false;
  }
}
</script>

<style scoped>
.bg-light {
  background-color: #f8f9fa !important;
}

.card {
  border-radius: 12px;
}

.display-1 {
  font-size: 4rem;
}

/* Archive section styles */
.archive-card {
  opacity: 0.8;
  transition: opacity 0.3s ease;
}

.archive-card:hover {
  opacity: 1;
}

.archive-card .card-header {
  background-color: #f8f9fa !important;
}

.archive-card .badge {
  font-size: 0.75rem;
}

/* Collapse button styles */
.btn[data-bs-toggle="collapse"] {
  transition: transform 0.2s ease;
}

.btn[data-bs-toggle="collapse"]:not(.collapsed) {
  transform: rotate(0deg);
}

.btn[data-bs-toggle="collapse"].collapsed {
  transform: rotate(0deg);
}

/* Archive section divider */
.mt-5 {
  border-top: 1px solid #e9ecef;
  padding-top: 1.5rem;
}
</style>
