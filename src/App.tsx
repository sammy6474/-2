/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  setDoc,
  doc, 
  Timestamp,
  getDocFromServer,
  getDocs,
  arrayUnion,
  arrayRemove
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { analyzePrescription, MedicationInfo, countMedicationPouches } from './services/geminiService';
import { 
  Pill, 
  PlusCircle, 
  Users, 
  CheckCircle2, 
  Camera, 
  LogOut, 
  ChevronLeft,
  Loader2,
  Volume2,
  Hash,
  AlertTriangle,
  Bell
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "알 수 없는 오류가 발생했습니다.";
      try {
        const parsed = JSON.parse(this.state.error?.message || "{}");
        if (parsed.error) {
          errorMessage = `데이터베이스 오류: ${parsed.error} (${parsed.operationType})`;
        }
      } catch {
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-red-50 flex items-center justify-center p-4 text-center">
          <div className="bg-white p-8 rounded-3xl border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] max-w-md">
            <h1 className="text-4xl font-black mb-4">앗! 오류가 발생했어요</h1>
            <p className="text-xl mb-6 text-gray-700">{errorMessage}</p>
            <Button onClick={() => window.location.reload()}>다시 시도하기</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Medication extends MedicationInfo {
  id: string;
  userId: string;
  takenToday: boolean;
  createdAt: Timestamp;
  status: 'pending_approval' | 'approved';
  imageUrl?: string;
  initialCount?: number;
  currentCount?: number;
}

interface UserProfile {
  role: 'senior' | 'guardian' | 'solo';
  name: string;
  groupCode?: string;
}

interface Group {
  adminId: string;
  groupCode: string;
  memberIds: string[];
}

enum View {
  LOGIN_ROLE = 'login_role',
  MAIN = 'main',
  TODAY = 'today',
  ADD = 'add',
  GUARDIAN = 'guardian',
  SENIOR_DETAIL = 'senior_detail',
  EDIT_MED = 'edit_med',
  REVIEW_MED = 'review_med',
  COUNT_MED = 'count_med'
}

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  variant = 'primary', 
  className = '',
  disabled = false,
  type = 'button'
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  variant?: 'primary' | 'secondary' | 'accent' | 'danger';
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}) => {
  const variants = {
    primary: 'bg-yellow-400 text-black border-4 border-black active:bg-yellow-500',
    secondary: 'bg-white text-black border-4 border-black active:bg-gray-100',
    accent: 'bg-blue-600 text-white border-4 border-black active:bg-blue-700',
    danger: 'bg-red-500 text-white border-4 border-black active:bg-red-600'
  };

  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      type={type}
      className={`
        w-full py-6 px-4 rounded-3xl text-3xl font-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]
        transition-all active:translate-x-1 active:translate-y-1 active:shadow-none
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variants[variant]}
        ${className}
      `}
    >
      {children}
    </button>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

const CameraCapture = ({ onCapture, onCancel, guideText = "약봉투를 이 칸에 맞춰주세요" }: { onCapture: (base64: string) => void; onCancel: () => void; guideText?: string }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
        });
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      } catch (err) {
        console.error("Camera error:", err);
        setError("카메라를 시작할 수 없습니다. 권한을 확인해주세요.");
      }
    };
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const capture = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg');
        onCapture(base64);
      }
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 bg-white rounded-3xl border-4 border-black">
        <p className="text-xl font-bold text-red-600">{error}</p>
        <Button onClick={onCancel} variant="secondary">뒤로가기</Button>
      </div>
    );
  }

  return (
    <div className="relative w-full aspect-[3/4] bg-black rounded-3xl border-4 border-black overflow-hidden">
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        className="w-full h-full object-cover"
      />
      
      {/* Camera Guide Overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[85%] aspect-[1.6/1] border-4 border-yellow-400 rounded-2xl shadow-[0_0_0_2000px_rgba(0,0,0,0.5)] flex items-center justify-center">
          <div className="text-yellow-400 font-black text-xl bg-black/50 px-4 py-2 rounded-lg text-center">
            {guideText}
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4 px-6">
        <button 
          onClick={onCancel}
          className="bg-white/20 backdrop-blur-md text-white p-4 rounded-full border-2 border-white active:bg-white/40"
        >
          <ChevronLeft className="w-8 h-8" />
        </button>
        <button 
          onClick={capture}
          className="bg-yellow-400 text-black p-6 rounded-full border-4 border-black shadow-lg active:scale-95 transition-transform"
        >
          <Camera className="w-10 h-10" />
        </button>
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(View.MAIN);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [seniors, setSeniors] = useState<{id: string, name: string}[]>([]);
  const [seniorStatus, setSeniorStatus] = useState<{[key: string]: string}>({});
  const [selectedSenior, setSelectedSenior] = useState<{id: string, name: string} | null>(null);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [groupCodeInput, setGroupCodeInput] = useState('');
  const [isEditingCode, setIsEditingCode] = useState(false);
  const [newGroupCode, setNewGroupCode] = useState('');
  const [guardianGroup, setGuardianGroup] = useState<Group | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [lastReminderTime, setLastReminderTime] = useState<number>(0);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyingMed, setVerifyingMed] = useState<Medication | null>(null);
  const [isCounting, setIsCounting] = useState(false);
  const [overDoseAlert, setOverDoseAlert] = useState<{
    medName: string;
    expected: number;
    actual: number;
    imageUrl: string;
  } | null>(null);
  const [activeReminder, setActiveReminder] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const checkProfile = async (uid: string) => {
    // Check localStorage first for mock users
    if (uid.startsWith('mock_')) {
      const savedProfile = localStorage.getItem(`profile_${uid}`);
      if (savedProfile) {
        setProfile(JSON.parse(savedProfile));
        setView(View.MAIN);
        return;
      }
      setView(View.LOGIN_ROLE);
      return;
    }

    const docRef = doc(db, 'users', uid);
    try {
      const docSnap = await getDocFromServer(docRef);
      if (docSnap.exists()) {
        setProfile(docSnap.data() as UserProfile);
        setView(View.MAIN);
      } else {
        setView(View.LOGIN_ROLE);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('permission-denied')) {
        handleFirestoreError(error, OperationType.GET, `users/${uid}`);
      }
      console.error("Profile check error:", error);
      setView(View.LOGIN_ROLE);
    }
  };

  // --- Auth & Data ---
  useEffect(() => {
    // Check for mock user first
    const savedMockUser = localStorage.getItem('mock_user');
    if (savedMockUser) {
      const u = JSON.parse(savedMockUser);
      setUser(u);
      checkProfile(u.uid);
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        checkProfile(u.uid);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user || !profile) return;

    if (user.uid.startsWith('mock_') && (profile.role === 'senior' || profile.role === 'solo')) {
      const syncMeds = () => {
        const allMeds = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('med_')) {
            const med = JSON.parse(localStorage.getItem(key) || '{}');
            if (med.userId === user.uid) allMeds.push(med);
          }
        }
        setMedications(allMeds);
      };
      syncMeds();
      const interval = setInterval(syncMeds, 2000);
      return () => clearInterval(interval);
    } else if (profile.role === 'senior' || profile.role === 'solo') {
      const q = query(collection(db, 'medications'), where('userId', '==', user.uid));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const meds = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Medication[];
        setMedications(meds);
      }, (error) => {
        if (error.message.includes('permission-denied')) {
          handleFirestoreError(error, OperationType.LIST, 'medications');
        }
        console.error("Firestore Error:", error);
      });
      return unsubscribe;
    }
  }, [user, profile]);

  // Guardian: Fetch Seniors in Group
  useEffect(() => {
    if (!user || profile?.role !== 'guardian') return;

    if (user.uid.startsWith('mock_')) {
      // Mock mode: check localStorage
      const syncMockGroup = async () => {
        const saved = localStorage.getItem(`group_${user.uid}`);
        if (saved) {
          const groupData = JSON.parse(saved) as Group;
          setGuardianGroup(groupData);
          const seniorList = [];
          for (const seniorId of groupData.memberIds) {
            const sProfile = JSON.parse(localStorage.getItem(`profile_${seniorId}`) || '{}');
            seniorList.push({ id: seniorId, name: sProfile.name || '어르신' });
            
            // Fetch status for mock mode
            const allMeds = [];
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key?.startsWith('med_')) {
                const med = JSON.parse(localStorage.getItem(key) || '{}');
                if (med.userId === seniorId) allMeds.push(med);
              }
            }
            const pendingCount = allMeds.filter(m => m.status === 'pending_approval').length;
            const untakenCount = allMeds.filter(m => m.status === 'approved' && !m.takenToday).length;
            
            let statusText = "모두 복용함";
            if (pendingCount > 0) statusText = `${pendingCount}건 승인 대기`;
            else if (untakenCount > 0) statusText = `${untakenCount}건 미복용`;
            
            setSeniorStatus(prev => ({ ...prev, [seniorId]: statusText }));
          }
          setSeniors(seniorList);
        }
      };
      syncMockGroup();
      // Poll for changes in mock mode since we don't have real-time listeners for localStorage
      const interval = setInterval(syncMockGroup, 2000);
      return () => clearInterval(interval);
    } else {
      const unsubscribe = onSnapshot(doc(db, 'groups', user.uid), async (snapshot) => {
        if (snapshot.exists()) {
          const groupData = snapshot.data() as Group;
          setGuardianGroup(groupData);
          const seniorList = [];
          for (const seniorId of groupData.memberIds) {
            try {
              const sDoc = await getDocFromServer(doc(db, 'users', seniorId));
              if (sDoc.exists()) {
                seniorList.push({ id: seniorId, name: sDoc.data().name });
                
                // Fetch status from Firestore
                const q = query(collection(db, 'medications'), where('userId', '==', seniorId));
                const mSnap = await getDocs(q);
                const meds = mSnap.docs.map(d => d.data());
                const pendingCount = meds.filter(m => m.status === 'pending_approval').length;
                const untakenCount = meds.filter(m => m.status === 'approved' && !m.takenToday).length;

                let statusText = "모두 복용함";
                if (pendingCount > 0) statusText = `${pendingCount}건 승인 대기`;
                else if (untakenCount > 0) statusText = `${untakenCount}건 미복용`;
                
                setSeniorStatus(prev => ({ ...prev, [seniorId]: statusText }));
              }
            } catch (error) {
              console.error("Error fetching senior data:", error);
            }
          }
          setSeniors(seniorList);
        }
      }, (error) => {
        if (error.message.includes('permission-denied')) {
          handleFirestoreError(error, OperationType.GET, `groups/${user.uid}`);
        }
      });
      return unsubscribe;
    }
  }, [user, profile]);

  // Guardian: Fetch Selected Senior's Meds
  useEffect(() => {
    if (!selectedSenior) return;

    if (selectedSenior.id.startsWith('mock_')) {
      const syncMeds = () => {
        const allMeds = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('med_')) {
            const med = JSON.parse(localStorage.getItem(key) || '{}');
            if (med.userId === selectedSenior.id) allMeds.push(med);
          }
        }
        setMedications(allMeds);
      };
      syncMeds();
      const interval = setInterval(syncMeds, 2000);
      return () => clearInterval(interval);
    } else {
      const q = query(collection(db, 'medications'), where('userId', '==', selectedSenior.id));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const meds = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Medication[];
        setMedications(meds);
      });
      return unsubscribe;
    }
  }, [selectedSenior]);

  // Test connection
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Firebase configuration error. Please check your setup.");
        }
      }
    };
    testConnection();
  }, []);

  // --- Handlers ---
  const handleRoleSelect = async (role: 'senior' | 'guardian' | 'solo') => {
    if (!user) return;
    const newProfile: UserProfile = {
      role,
      name: user.displayName || '사용자',
    };

    try {
      // If it's a mock user, save to localStorage instead of Firestore
      if (user.uid.startsWith('mock_')) {
        localStorage.setItem(`profile_${user.uid}`, JSON.stringify(newProfile));
      } else {
        try {
          await setDoc(doc(db, 'users', user.uid), newProfile);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
        }
      }
      
      if (role === 'guardian') {
        // Check if group already exists
        let existingGroup = null;
        if (user.uid.startsWith('mock_')) {
          const saved = localStorage.getItem(`group_${user.uid}`);
          if (saved) existingGroup = JSON.parse(saved);
        } else {
          const gSnap = await getDocFromServer(doc(db, 'groups', user.uid));
          if (gSnap.exists()) existingGroup = gSnap.data();
        }

        if (!existingGroup) {
          const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
          const newGroup = {
            adminId: user.uid,
            groupCode,
            memberIds: []
          };
          
          if (user.uid.startsWith('mock_')) {
            localStorage.setItem(`group_${user.uid}`, JSON.stringify(newGroup));
          } else {
            try {
              await setDoc(doc(db, 'groups', user.uid), newGroup);
            } catch (error) {
              handleFirestoreError(error, OperationType.WRITE, `groups/${user.uid}`);
            }
          }
        }
      }
      
      setProfile(newProfile);
      setView(View.MAIN);
      setFeedback(`${role === 'senior' ? '어르신' : '보호자'} 모드로 시작합니다!`);
      setTimeout(() => setFeedback(null), 1000);
    } catch (error) {
      console.error("Role select error:", error);
      // Fallback for UI transition even if DB fails
      setProfile(newProfile);
      setView(View.MAIN);
    }
  };

  const handleJoinGroup = async () => {
    if (!user || !groupCodeInput) return;
    
    try {
      const code = groupCodeInput.toUpperCase();
      let groupData: Group | null = null;
      let groupId: string | null = null;

      // 1. Find the group with this code
      // First, check Firestore
      const groupsRef = collection(db, 'groups');
      const q = query(groupsRef, where('groupCode', '==', code));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        groupId = querySnapshot.docs[0].id;
        groupData = querySnapshot.docs[0].data() as Group;
        console.log("Found group in Firestore:", groupId);
      } else {
        console.log("Group not found in Firestore, checking localStorage...");
        // If not in Firestore, check localStorage (for mock/prototype testing on same device)
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('group_mock_')) {
            const data = JSON.parse(localStorage.getItem(key) || '{}');
            if (data.groupCode === code) {
              groupData = data;
              groupId = key.replace('group_', '');
              break;
            }
          }
        }
      }
      
      if (!groupData || !groupId) {
        setFeedback("존재하지 않는 그룹 코드입니다.");
        setTimeout(() => setFeedback(null), 3000);
        return;
      }

      // 2. Add senior to the group's memberIds
      console.log("Joining group:", groupId, "as user:", user.uid);
      if (groupId.startsWith('mock_')) {
        const updatedGroup = {
          ...groupData,
          memberIds: Array.from(new Set([...(groupData.memberIds || []), user.uid]))
        };
        localStorage.setItem(`group_${groupId}`, JSON.stringify(updatedGroup));
      } else {
        try {
          // Ensure the document exists and has memberIds array
          await setDoc(doc(db, 'groups', groupId), {
            memberIds: arrayUnion(user.uid)
          }, { merge: true });
          console.log("Successfully updated group memberIds");
        } catch (error) {
          console.error("Error updating group memberIds:", error);
          handleFirestoreError(error, OperationType.UPDATE, `groups/${groupId}`);
        }
      }

      // 3. Update senior's profile
      console.log("Updating user profile with groupCode:", code);
      if (user.uid.startsWith('mock_')) {
        const profile = JSON.parse(localStorage.getItem(`profile_${user.uid}`) || '{}');
        profile.groupCode = code;
        localStorage.setItem(`profile_${user.uid}`, JSON.stringify(profile));
      } else {
        try {
          await updateDoc(doc(db, 'users', user.uid), {
            groupCode: code
          } as any);
          console.log("Successfully updated user profile");
        } catch (error) {
          console.error("Error updating user profile:", error);
          handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
        }
      }
      
      setProfile(prev => prev ? { ...prev, groupCode: code } : null);
      setFeedback("그룹에 연결되었습니다!");
      setTimeout(() => setFeedback(null), 3000);
      setGroupCodeInput('');
    } catch (error: any) {
      console.error("Join group error:", error);
      let reason = error.message || '알 수 없는 오류';
      if (error.code === 'permission-denied') {
        reason = "보안 규칙에 의해 거부되었습니다. 보호자에게 문의하세요.";
      }
      setFeedback(`연결 실패: ${reason} (${error.code || 'no-code'})`);
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  const handleUpdateGroupCode = async () => {
    if (!user || !newGroupCode) return;
    const code = newGroupCode.toUpperCase();
    
    if (code.length !== 6 || !/^[A-Z0-9]+$/.test(code)) {
      setFeedback("코드는 영문/숫자 6자리여야 합니다.");
      setTimeout(() => setFeedback(null), 3000);
      return;
    }

    try {
      // Check for duplicates
      const groupsRef = collection(db, 'groups');
      const q = query(groupsRef, where('groupCode', '==', code));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty && querySnapshot.docs[0].id !== user.uid) {
        setFeedback("이미 사용 중인 코드입니다. 다른 코드를 입력해주세요.");
        setTimeout(() => setFeedback(null), 3000);
        return;
      }

      if (user.uid.startsWith('mock_')) {
        const group = JSON.parse(localStorage.getItem(`group_${user.uid}`) || '{}');
        group.groupCode = code;
        group.adminId = user.uid;
        if (!group.memberIds) group.memberIds = [];
        localStorage.setItem(`group_${user.uid}`, JSON.stringify(group));
        setGuardianGroup(group);
      } else {
        // Use setDoc with merge to be more robust if doc doesn't exist
        await setDoc(doc(db, 'groups', user.uid), {
          groupCode: code,
          adminId: user.uid
        }, { merge: true });
      }
      
      setIsEditingCode(false);
      setFeedback("그룹 코드가 변경되었습니다!");
      setTimeout(() => setFeedback(null), 3000);
    } catch (error: any) {
      console.error("Update group code error:", error);
      let reason = error.message || '알 수 없는 오류';
      if (error.code === 'permission-denied') {
        reason = "보안 규칙에 의해 거부되었습니다 (권한 없음).";
      } else if (error.code === 'unavailable') {
        reason = "네트워크 연결이 불안정합니다.";
      }
      setFeedback(`코드 변경 실패: ${reason} (${error.code || 'no-code'})`);
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setProfile(null);
      setUser(null);
      setView(View.MAIN);
      localStorage.removeItem('mock_user');
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  const handleResetRole = async () => {
    if (!user) return;
    console.log("Resetting role...");
    setFeedback("역할 선택 화면으로 이동합니다...");
    setTimeout(() => {
      setView(View.LOGIN_ROLE);
      setProfile(null);
      if (user.uid.startsWith('mock_')) {
        localStorage.removeItem(`profile_${user.uid}`);
      }
      setFeedback(null);
    }, 1000);
  };

  const handleMockLogin = () => {
    const mockUser = {
      uid: 'mock_user_123',
      displayName: '테스트 사용자',
      email: 'test@example.com'
    };
    localStorage.setItem('mock_user', JSON.stringify(mockUser));
    setUser(mockUser as any);
    setLoading(false);
    checkProfile(mockUser.uid);
  };

  const handleApproveMed = async (med: Medication) => {
    try {
      if (med.id.startsWith('mock_med_')) {
        const saved = localStorage.getItem(`med_${med.id}`);
        if (saved) {
          const data = JSON.parse(saved);
          data.name = med.name;
          data.instructions = med.instructions;
          data.schedule = med.schedule;
          data.status = 'approved';
          localStorage.setItem(`med_${med.id}`, JSON.stringify(data));
        }
      } else {
        await updateDoc(doc(db, 'medications', med.id), {
          name: med.name,
          instructions: med.instructions,
          schedule: med.schedule,
          status: 'approved'
        });
      }
      if (profile?.role === 'solo') {
        setView(View.TODAY);
      } else {
        setView(View.SENIOR_DETAIL);
      }
      setFeedback("승인 및 저장되었습니다!");
      setTimeout(() => setFeedback(null), 2000);
    } catch (error) {
      console.error("Approve error:", error);
      setFeedback("승인 중 오류가 발생했습니다.");
    }
  };

  const handleUpdateMed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMed) return;

    if (editingMed.id.startsWith('mock_med_')) {
      const saved = localStorage.getItem(`med_${editingMed.id}`);
      if (saved) {
        const data = JSON.parse(saved);
        data.name = editingMed.name;
        data.instructions = editingMed.instructions;
        data.status = 'approved';
        localStorage.setItem(`med_${editingMed.id}`, JSON.stringify(data));
      }
    } else {
      await updateDoc(doc(db, 'medications', editingMed.id), {
        name: editingMed.name,
        instructions: editingMed.instructions,
        status: 'approved'
      });
    }
    
    setEditingMed(null);
    if (profile?.role === 'solo') {
      setView(View.TODAY);
    } else {
      setView(View.SENIOR_DETAIL);
    }
    setFeedback("수정 및 승인 완료!");
    setTimeout(() => setFeedback(null), 2000);
  };

  // --- Reminders ---
  useEffect(() => {
    if (!user || (profile?.role !== 'senior' && profile?.role !== 'solo')) return;

    const checkReminders = () => {
      const now = new Date();
      const hour = now.getHours();
      const currentTime = now.getTime();

      // 1시간에 한 번만 알림 (테스트를 위해 1분으로 조정 가능)
      if (currentTime - lastReminderTime < 3600000) return;

      let targetSchedule = "";
      if (hour >= 6 && hour < 10) targetSchedule = "morning";
      else if (hour >= 11 && hour < 14) targetSchedule = "afternoon";
      else if (hour >= 17 && hour < 21) targetSchedule = "evening";

      if (targetSchedule) {
        const dueMeds = medications.filter(m => 
          m.status === 'approved' && 
          !m.takenToday && 
          m.schedule.includes(targetSchedule)
        );

        if (dueMeds.length > 0) {
          const scheduleName = targetSchedule === "morning" ? "아침" : targetSchedule === "afternoon" ? "점심" : "저녁";
          const msg = `어르신, ${scheduleName} 약 드실 시간이에요. 드시고 나서 꼭 '먹었어'라고 말씀해 주세요.`;
          speak(msg);
          setFeedback(msg);
          setLastReminderTime(currentTime);
          setTimeout(() => setFeedback(null), 10000);
        }
      }
    };

    const interval = setInterval(checkReminders, 60000); // 1분마다 체크
    return () => clearInterval(interval);
  }, [user, profile, medications, lastReminderTime]);

  const speak = (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 0.8; // 어르신을 위해 조금 천천히
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  const triggerReminder = (schedule: string) => {
    setActiveReminder(schedule);
    const scheduleName = schedule === "morning" ? "아침" : schedule === "afternoon" ? "점심" : "저녁";
    const msg = `어르신, ${scheduleName} 약 드실 시간이에요. 약을 드셨다면 '먹었어'라고 말씀하시거나 확인 버튼을 눌러주세요.`;
    speak(msg);
    startListening(true); // Start listening specifically for confirmation
  };

  const startListening = (isForReminder = false) => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setFeedback("이 브라우저는 음성 인식을 지원하지 않아요. 크롬 브라우저를 권장합니다.");
      setTimeout(() => setFeedback(null), 3000);
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = 'ko-KR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      if (!isForReminder) {
        setFeedback("말씀해 주세요... (예: '약 먹었어')");
      }
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      console.log("인식된 음성:", transcript);
      
      if (transcript.includes("먹었어") || transcript.includes("응") || transcript.includes("방금") || transcript.includes("복용") || transcript.includes("확인")) {
        if (isForReminder && activeReminder) {
          const scheduleToConfirm = activeReminder;
          setActiveReminder(null);
          const dueMeds = medications.filter(m => 
            m.status === 'approved' && 
            !m.takenToday && 
            m.schedule.includes(scheduleToConfirm)
          );
          if (dueMeds.length > 0) {
            handleTakeMed(dueMeds[0]);
          }
        } else {
          // General "I ate" logic
          const untakenMeds = medications.filter(m => m.status === 'approved' && !m.takenToday);
          if (untakenMeds.length > 0) {
            handleTakeMed(untakenMeds[0]);
          } else {
            const takenMeds = medications.filter(m => m.status === 'approved' && m.takenToday);
            if (takenMeds.length > 0) {
              const msg = "어르신, 이미 약을 드셨어요! 지금 또 드시면 몸에 해로울 수 있으니 다음 복용 시간까지 기다려 주세요. 제가 기록을 확인해 보니 이미 드셨네요. 안심하세요.";
              speak(msg);
              setFeedback(msg);
              setTimeout(() => setFeedback(null), 8000);
            } else {
              speak("아직 등록된 약이 없거나 이미 모두 드셨네요. 안심하세요.");
              setFeedback("등록된 약이 없거나 이미 모두 드셨네요.");
              setTimeout(() => setFeedback(null), 3000);
            }
          }
        }
      } else if (transcript.includes("먹었나") || transcript.includes("확인")) {
        const untakenMeds = medications.filter(m => m.status === 'approved' && !m.takenToday);
        if (untakenMeds.length > 0) {
          const msg = "아직 안 드신 것으로 나와요. 지금 드시면 됩니다.";
          speak(msg);
          setFeedback(msg);
        } else {
          const msg = "제가 기록을 확인해 보니 이미 드셨네요. 안심하세요.";
          speak(msg);
          setFeedback(msg);
        }
        setTimeout(() => setFeedback(null), 5000);
      } else {
        setFeedback(`인식된 내용: "${transcript}"`);
        setTimeout(() => setFeedback(null), 3000);
      }
    };

    recognition.onerror = (event: any) => {
      console.error("음성 인식 오류:", event.error);
      setIsListening(false);
      
      let errorMsg = "음성 인식 중 오류가 발생했어요.";
      if (event.error === 'not-allowed') {
        errorMsg = "마이크 사용 권한이 필요합니다. 브라우저 설정을 확인해 주세요.";
      } else if (event.error === 'no-speech') {
        errorMsg = "말씀이 들리지 않아요. 다시 시도해 주세요.";
      } else if (event.error === 'network') {
        errorMsg = "네트워크 연결을 확인해 주세요.";
      }
      
      setFeedback(errorMsg);
      setTimeout(() => setFeedback(null), 3000);
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    try {
      recognition.start();
    } catch (e) {
      console.error("Recognition start error:", e);
      setIsListening(false);
    }
  };

  const handleTakeMed = async (med: Medication) => {
    if (med.takenToday) {
      const msg = "어르신, 이미 약을 드셨어요! 지금 또 드시면 몸에 해로울 수 있으니 다음 복용 시간까지 기다려 주세요.";
      speak(msg);
      setFeedback(msg);
      setTimeout(() => setFeedback(null), 5000);
      return;
    }

    if (med.initialCount !== undefined) {
      setVerifyingMed(med);
      setIsVerifying(true);
      speak("약을 드셨나요? 남은 약봉지들을 펴서 사진을 찍어주세요. 갯수를 확인해볼게요.");
      return;
    }

    try {
      if (med.id.startsWith('mock_med_')) {
        const saved = localStorage.getItem(`med_${med.id}`);
        if (saved) {
          const data = JSON.parse(saved);
          data.takenToday = true;
          localStorage.setItem(`med_${med.id}`, JSON.stringify(data));
        }
      } else {
        await updateDoc(doc(db, 'medications', med.id), {
          takenToday: true
        });
      }
      const successMsg = "잘하셨어요! 오늘 약 복용 완료하셨다고 기록해 둘게요.";
      speak(successMsg);
      setFeedback(successMsg + " 👍");
      setTimeout(() => setFeedback(null), 3000);
    } catch (error) {
      console.error("Update error:", error);
    }
  };

  const handleCountPouches = async (base64Full: string) => {
    if (!user) return;
    const base64 = base64Full.split(',')[1];
    setIsCounting(true);
    try {
      const count = await countMedicationPouches(base64);
      if (count !== null) {
        const approvedMeds = medications.filter(m => m.status === 'approved');
        for (const med of approvedMeds) {
          if (med.id.startsWith('mock_med_')) {
            const saved = localStorage.getItem(`med_${med.id}`);
            if (saved) {
              const data = JSON.parse(saved);
              data.initialCount = count;
              data.currentCount = count;
              localStorage.setItem(`med_${med.id}`, JSON.stringify(data));
            }
          } else {
            await updateDoc(doc(db, 'medications', med.id), {
              initialCount: count,
              currentCount: count
            });
          }
        }
        speak(`현재 약봉지가 ${count}개 있는 것을 확인했습니다. 잘 저장해둘게요.`);
        setFeedback(`약봉지 ${count}개 확인 완료!`);
        setView(View.MAIN);
      } else {
        setFeedback("약봉지 개수를 확인하지 못했습니다. 다시 시도해주세요.");
      }
    } catch (error) {
      console.error("Count error:", error);
      setFeedback("오류가 발생했습니다.");
    } finally {
      setIsCounting(false);
    }
  };

  const handleVerifyConsumption = async (base64Full: string) => {
    if (!user || !verifyingMed) return;
    const base64 = base64Full.split(',')[1];
    setIsCounting(true);
    try {
      const newCount = await countMedicationPouches(base64);
      if (newCount !== null) {
        const currentCount = verifyingMed.currentCount || 0;
        const expectedCount = currentCount - 1;
        
        if (newCount === expectedCount) {
          await finalizeTakeMed(verifyingMed, newCount);
          const msg = "정상적으로 1봉지 복용하셨네요. 잘하셨습니다!";
          speak(msg);
          setFeedback(msg + " ✅");
          setTimeout(() => setFeedback(null), 3000);
        } else if (newCount < expectedCount) {
          setOverDoseAlert({
            medName: verifyingMed.name,
            expected: expectedCount,
            actual: newCount,
            imageUrl: base64Full
          });
          const msg = `경고! 약을 ${currentCount - newCount}봉지나 드신 것 같아요. 과복용은 위험할 수 있습니다!`;
          speak(msg);
          // In a real app, we would send an alert to the guardian here
        } else {
          const msg = "아직 약을 드시지 않은 것 같아요. 약을 드신 후에 다시 사진을 찍어주세요.";
          speak(msg);
          setFeedback(msg);
          setTimeout(() => setFeedback(null), 5000);
        }
      } else {
        setFeedback("약봉지 개수를 확인하지 못했습니다. 다시 시도해주세요.");
      }
    } catch (error) {
      console.error("Verify error:", error);
    } finally {
      setIsCounting(false);
      setIsVerifying(false);
      setVerifyingMed(null);
    }
  };

  const finalizeTakeMed = async (med: Medication, newCount?: number) => {
    try {
      const updates: any = { takenToday: true };
      if (newCount !== undefined) updates.currentCount = newCount;

      if (med.id.startsWith('mock_med_')) {
        const saved = localStorage.getItem(`med_${med.id}`);
        if (saved) {
          const data = JSON.parse(saved);
          Object.assign(data, updates);
          localStorage.setItem(`med_${med.id}`, JSON.stringify(data));
        }
      } else {
        await updateDoc(doc(db, 'medications', med.id), updates);
      }
    } catch (error) {
      console.error("Finalize error:", error);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement> | string) => {
    let base64 = "";
    let fullBase64 = "";

    if (typeof e === 'string') {
      // Direct base64 from custom camera
      fullBase64 = e;
      base64 = e.split(',')[1];
    } else {
      const file = e.target.files?.[0];
      if (!file || !user) return;
      
      const reader = new FileReader();
      const result = await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      fullBase64 = result;
      base64 = result.split(',')[1];
    }

    if (!user) return;

    setAnalyzing(true);
    try {
      const medicationsInfo = await analyzePrescription(base64);
      
      if (medicationsInfo && medicationsInfo.length > 0) {
        for (const info of medicationsInfo) {
          const medData = {
            ...info,
            userId: user.uid,
            takenToday: false,
            status: profile?.role === 'solo' ? 'approved' : 'pending_approval',
            createdAt: user.uid.startsWith('mock_') ? new Date().toISOString() : Timestamp.now(),
            imageUrl: fullBase64
          };

          if (user.uid.startsWith('mock_')) {
            const medId = `mock_med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            localStorage.setItem(`med_${medId}`, JSON.stringify({ ...medData, id: medId }));
          } else {
            await addDoc(collection(db, 'medications'), medData as any);
          }
        }
        
        setView(View.MAIN);
        const count = medicationsInfo.length;
        if (profile?.role === 'solo') {
          speak(`${count}개의 약이 등록되었습니다. 바로 확인 가능합니다.`);
          setFeedback(`${count}개의 약 등록 완료!`);
        } else {
          speak(`${count}개의 약이 등록되었습니다. 보호자 승인 후 확인 가능합니다.`);
          setFeedback(`${count}개의 약 등록 완료 (승인 대기)`);
        }
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setFeedback("약봉투에서 약 정보를 찾지 못했습니다. 다시 시도해주세요.");
        setTimeout(() => setFeedback(null), 3000);
      }
      setAnalyzing(false);
    } catch (error) {
      console.error("Analysis error:", error);
      setAnalyzing(false);
      setFeedback("분석 중 오류가 발생했습니다.");
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  const seedMockData = async () => {
    if (!user) return;
    const mockMeds = [
      {
        name: "혈압약 (아모디핀)",
        schedule: ["morning"],
        instructions: "아침 식사 후 30분에 드세요.",
        userId: user.uid,
        takenToday: false,
        status: 'approved',
        createdAt: user.uid.startsWith('mock_') ? new Date().toISOString() : Timestamp.now()
      },
      {
        name: "비타민 D",
        schedule: ["morning", "evening"],
        instructions: "충분한 물과 함께 드세요.",
        userId: user.uid,
        takenToday: false,
        status: 'approved',
        createdAt: user.uid.startsWith('mock_') ? new Date().toISOString() : Timestamp.now()
      }
    ];

    try {
      for (const med of mockMeds) {
        if (user.uid.startsWith('mock_')) {
          const medId = `mock_med_${Math.random().toString(36).substring(2, 11)}`;
          localStorage.setItem(`med_${medId}`, JSON.stringify({ ...med, id: medId }));
        } else {
          await addDoc(collection(db, 'medications'), med as any);
        }
      }
      speak("예시 약 데이터가 등록되었습니다.");
    } catch (error) {
      console.error("Seed error:", error);
    }
  };

  // --- Views ---

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-200 flex justify-center items-start sm:items-center overflow-x-hidden">
        <div className="w-full max-w-[450px] min-h-screen sm:min-h-[850px] sm:h-[90vh] bg-yellow-50 flex items-center justify-center border-x-0 sm:border-x-8 border-black shadow-2xl">
          <Loader2 className="w-16 h-16 animate-spin text-yellow-600" />
        </div>
      </div>
    );
  }

  // 1. Login Screen
  if (!user) {
    return (
      <div className="min-h-screen bg-gray-200 flex justify-center items-start sm:items-center overflow-x-hidden p-0 sm:p-4">
        <div className="w-full max-w-[450px] min-h-screen sm:min-h-[850px] sm:h-[90vh] bg-yellow-50 p-6 flex flex-col items-center justify-center text-center border-x-0 sm:border-8 border-black shadow-2xl overflow-y-auto">
          <div className="mb-12 w-full px-4">
            <div className="bg-white p-8 rounded-full border-8 border-black mb-6 inline-block shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
              <Pill className="w-20 h-20 text-blue-600" />
            </div>
            <h1 className="text-5xl font-black mb-4 break-words">실버보이스</h1>
            <p className="text-2xl font-bold text-gray-700 leading-relaxed">어르신의 건강한 하루를 돕는<br/>다정한 복약 비서입니다</p>
          </div>
          
          <div className="flex flex-col gap-4 w-full max-w-xs">
            <Button onClick={signInWithGoogle} variant="primary">
              구글로 시작하기
            </Button>
            <Button onClick={handleMockLogin} variant="secondary">
              테스트 모드로 시작
            </Button>
          </div>
          
          <p className="mt-8 text-sm text-gray-500 font-bold">
            ※ 실제 로그인이 부담스러우시면<br/>'테스트 모드'를 이용해 보세요.
          </p>
        </div>
      </div>
    );
  }

  // 2. Role Selection (Landing Page)
  if (!profile || view === View.LOGIN_ROLE) {
    return (
      <div className="min-h-screen bg-gray-200 flex justify-center items-start sm:items-center overflow-x-hidden p-0 sm:p-4">
        <div className="w-full max-w-[450px] min-h-screen sm:min-h-[850px] sm:h-[90vh] bg-yellow-50 p-6 flex flex-col items-center justify-center border-x-0 sm:border-8 border-black shadow-2xl">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col gap-8 w-full"
          >
            <h2 className="text-4xl font-black text-center mb-4 leading-tight">반갑습니다!<br/>역할을 선택해주세요</h2>
            <Button onClick={() => handleRoleSelect('senior')} variant="primary" className="h-48">
              <div className="flex flex-col items-center gap-2">
                <Pill className="w-16 h-16" />
                <span>피보호자 (어르신)</span>
              </div>
            </Button>
            <Button onClick={() => handleRoleSelect('guardian')} variant="accent" className="h-40">
              <div className="flex flex-col items-center gap-2">
                <Users className="w-12 h-12" />
                <span>보호자 (가족/돌보미)</span>
              </div>
            </Button>
            <Button onClick={() => handleRoleSelect('solo')} variant="secondary" className="h-40">
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-12 h-12 text-green-600" />
                <span>혼자 관리 (알림 전용)</span>
              </div>
            </Button>
            
            <button 
              onClick={handleLogout}
              className="mt-4 text-xl font-bold text-gray-500 underline decoration-2 underline-offset-4"
            >
              로그아웃하고 처음으로
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  // 3. Main Application
  return (
    <div className="min-h-screen bg-gray-200 flex justify-center items-start sm:items-center overflow-x-hidden">
      <div className="w-full max-w-[450px] min-h-screen sm:min-h-[850px] sm:h-[90vh] bg-yellow-50 flex flex-col font-sans text-black border-x-0 sm:border-x-8 border-black shadow-2xl relative overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b-8 border-black p-4 flex justify-between items-center sticky top-0 z-40 w-full">
          <div 
            onClick={() => setView(View.MAIN)} 
            className="flex items-center gap-3 overflow-hidden cursor-pointer active:opacity-70"
          >
            <div className="bg-yellow-400 p-2 rounded-xl border-4 border-black flex-shrink-0">
              <Pill className="w-6 h-6 sm:w-8 sm:h-8" />
            </div>
            <span className="text-2xl sm:text-3xl font-black truncate">실버보이스</span>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={handleResetRole} 
              title="역할 변경"
              className="p-2 sm:p-3 bg-blue-100 rounded-2xl border-4 border-black hover:bg-blue-200 transition-colors"
            >
              <Users className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
            <button 
              onClick={handleLogout} 
              title="로그아웃"
              className="p-2 sm:p-3 bg-gray-200 rounded-2xl border-4 border-black hover:bg-gray-300 transition-colors"
            >
              <LogOut className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </header>

        <main className="flex-1 p-5 flex flex-col gap-5 overflow-y-auto">
        <AnimatePresence mode="wait">
          {view === View.MAIN && (profile?.role === 'senior' || profile?.role === 'solo') && (
            <motion.div 
              key="senior-main"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col gap-8"
            >
              <div className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <h2 className="text-3xl font-black mb-2">안녕하세요, {profile.name}님!</h2>
                <p className="text-2xl font-bold text-gray-600">오늘도 건강한 하루 되세요.</p>
                {profile.role === 'senior' && !profile.groupCode && (
                  <div className="mt-6 p-4 bg-blue-50 rounded-2xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <p className="text-xl font-bold text-blue-800 mb-4 leading-tight">보호자 그룹 코드를 입력해 연결하세요.</p>
                    <div className="flex flex-col gap-3">
                      <input 
                        type="text" 
                        value={groupCodeInput}
                        onChange={(e) => setGroupCodeInput(e.target.value)}
                        placeholder="코드 입력 (예: ABCDEF)"
                        className="w-full p-4 rounded-xl border-4 border-black text-2xl font-bold focus:outline-none focus:ring-4 focus:ring-blue-200"
                      />
                      <Button 
                        onClick={handleJoinGroup}
                        variant="accent"
                        className="py-4"
                      >
                        연결하기
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-4">
                <Button onClick={() => setView(View.TODAY)} className="h-40">
                  <div className="flex flex-col items-center gap-2">
                    <CheckCircle2 className="w-14 h-14" />
                    <span>오늘 먹을 약</span>
                  </div>
                </Button>

                <Button onClick={() => setView(View.COUNT_MED)} variant="accent" className="h-40">
                  <div className="flex flex-col items-center gap-2">
                    <Hash className="w-14 h-14" />
                    <span>약 갯수 확인하기</span>
                  </div>
                </Button>
              </div>

              <Button onClick={() => setView(View.ADD)} variant="secondary" className="h-40">
                <div className="flex flex-col items-center gap-2">
                  <PlusCircle className="w-14 h-14" />
                  <span>약 등록하기</span>
                </div>
              </Button>

              <div className="mt-auto pt-8 border-t-8 border-black">
                <p className="text-xl font-black mb-4">알람 테스트 (임시)</p>
                <div className="grid grid-cols-3 gap-3">
                  <Button onClick={() => triggerReminder('morning')} variant="primary" className="py-4 text-xl">아침</Button>
                  <Button onClick={() => triggerReminder('afternoon')} variant="primary" className="py-4 text-xl">점심</Button>
                  <Button onClick={() => triggerReminder('evening')} variant="primary" className="py-4 text-xl">저녁</Button>
                </div>
              </div>
            </motion.div>
          )}

          {view === View.MAIN && profile?.role === 'guardian' && (
            <motion.div 
              key="guardian-main"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col gap-6"
            >
              <div className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <h2 className="text-3xl font-black mb-2">보호자 관리 대시보드</h2>
                <p className="text-xl font-bold text-gray-600">연결된 어르신들을 관리합니다.</p>
                <div className="mt-4 p-4 bg-yellow-100 rounded-2xl border-4 border-black">
                  <div className="flex justify-between items-center mb-2">
                    <p className="text-lg font-bold">내 그룹 코드</p>
                    <button 
                      onClick={() => {
                        setIsEditingCode(!isEditingCode);
                        setNewGroupCode(guardianGroup?.groupCode || '');
                      }}
                      className="text-blue-600 font-black underline"
                    >
                      {isEditingCode ? '취소' : '변경'}
                    </button>
                  </div>
                  
                  {isEditingCode ? (
                    <div className="flex flex-col gap-2">
                      <input 
                        type="text"
                        maxLength={6}
                        value={newGroupCode}
                        onChange={(e) => setNewGroupCode(e.target.value.toUpperCase())}
                        className="w-full p-3 rounded-xl border-4 border-black text-2xl font-black"
                        placeholder="6자리 코드"
                      />
                      <Button onClick={handleUpdateGroupCode} variant="accent" className="py-3 text-xl">
                        저장하기
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-4xl font-black text-blue-600 tracking-widest">
                        {guardianGroup?.groupCode || '------'}
                      </p>
                      <p className="text-sm text-gray-600 mt-2 font-bold">어르신 앱에 이 코드를 입력하면 연결됩니다.</p>
                    </>
                  )}
                </div>
              </div>

              <h3 className="text-3xl font-black mt-4">피보호자 목록</h3>
              
              {seniors.length === 0 ? (
                <div className="flex flex-col gap-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="bg-white p-8 rounded-[32px] border-4 border-black border-dashed flex flex-col items-center justify-center text-gray-400">
                      <Users className="w-10 h-10 mb-2 opacity-20" />
                      <p className="text-xl font-bold opacity-40">연결된 어르신이 없습니다</p>
                    </div>
                  ))}
                </div>
              ) : (
                seniors.map(senior => (
                  <div 
                    key={senior.id}
                    onClick={() => {
                      setSelectedSenior({ id: senior.id, name: senior.name });
                      setView(View.SENIOR_DETAIL);
                    }}
                    className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] flex justify-between items-center cursor-pointer active:translate-x-1 active:translate-y-1 active:shadow-none overflow-hidden gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-2xl font-black truncate">{senior.name}</p>
                      <p className={`text-lg font-bold ${seniorStatus[senior.id]?.includes('대기') || seniorStatus[senior.id]?.includes('미복용') ? 'text-red-600' : 'text-green-600'}`}>
                        {seniorStatus[senior.id] || "상태 확인 중..."}
                      </p>
                    </div>
                    <ChevronLeft className="w-8 h-8 rotate-180 flex-shrink-0" />
                  </div>
                ))
              )}

              <div className="mt-10 pt-10 border-t-8 border-black">
                <Button onClick={handleResetRole} variant="secondary">
                  처음 화면으로 (역할 변경)
                </Button>
                <p className="mt-4 text-center text-gray-500 font-bold">
                  다른 어르신을 관리하거나 역할을 바꾸려면<br/>위 버튼을 눌러주세요.
                </p>
              </div>
            </motion.div>
          )}

          {view === View.SENIOR_DETAIL && selectedSenior && (
            <motion.div 
              key="senior-detail"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex flex-col gap-6"
            >
              <button onClick={() => setView(View.MAIN)} className="flex items-center gap-2 text-2xl font-black mb-2">
                <ChevronLeft className="w-8 h-8" /> 대시보드로
              </button>
              
              <h2 className="text-3xl font-black">{selectedSenior.name}님의 약</h2>

              {medications.length === 0 ? (
                <div className="bg-white p-8 rounded-[32px] border-4 border-black border-dashed text-center text-gray-400 font-bold">
                  등록된 약이 없습니다.
                </div>
              ) : (
                medications.map(med => (
                  <div key={med.id} className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] overflow-hidden">
                    <div className="flex justify-between items-start mb-2 gap-2">
                      <h3 className="text-2xl font-black break-words flex-1">{med.name}</h3>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold border-2 border-black flex-shrink-0 ${med.status === 'approved' ? 'bg-green-200' : 'bg-red-200'}`}>
                        {med.status === 'approved' ? '승인됨' : '승인 대기'}
                      </span>
                    </div>
                    <p className="text-lg font-bold text-gray-600 mb-4 break-words">주의: {med.instructions}</p>
                    
                    <div className="flex gap-3">
                      {med.status === 'pending_approval' ? (
                        <Button 
                          onClick={() => {
                            setEditingMed(med);
                            setView(View.REVIEW_MED);
                          }} 
                          variant="primary" 
                          className="py-3 text-xl"
                        >
                          확인
                        </Button>
                      ) : (
                        <Button 
                          onClick={() => {
                            setEditingMed(med);
                            setView(View.EDIT_MED);
                          }} 
                          variant="secondary" 
                          className="py-3 text-xl"
                        >
                          수정
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </motion.div>
          )}

          {view === View.REVIEW_MED && editingMed && (
            <motion.div 
              key="review-med"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-6"
            >
              <button onClick={() => setView(View.SENIOR_DETAIL)} className="flex items-center gap-2 text-2xl font-black mb-2">
                <ChevronLeft className="w-8 h-8" /> 뒤로가기
              </button>
              
              <h2 className="text-3xl font-black">약 등록 정보 확인 및 수정</h2>

              <div className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <p className="text-xl font-black text-blue-600">어르신이 찍은 사진</p>
                  {editingMed.imageUrl ? (
                    <div className="relative group">
                      <img 
                        src={editingMed.imageUrl} 
                        alt="Prescription" 
                        className="w-full rounded-2xl border-4 border-black object-cover max-h-80 shadow-md"
                        referrerPolicy="no-referrer"
                      />
                      <div className="absolute top-2 right-2 bg-black/60 text-white px-3 py-1 rounded-full text-sm font-bold">
                        원본 사진
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-40 bg-gray-100 rounded-2xl border-4 border-black border-dashed flex items-center justify-center text-gray-400 font-bold">
                      사진이 없습니다.
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-4 border-t-4 border-black pt-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-lg font-black text-gray-700">약 이름</label>
                    <input 
                      type="text" 
                      value={editingMed.name}
                      onChange={(e) => setEditingMed({...editingMed, name: e.target.value})}
                      className="p-4 rounded-2xl border-4 border-black text-2xl font-bold bg-yellow-50 focus:bg-white transition-colors"
                      placeholder="약 이름을 입력하세요"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-lg font-black text-gray-700">복용 방법 및 주의사항</label>
                    <textarea 
                      value={editingMed.instructions}
                      onChange={(e) => setEditingMed({...editingMed, instructions: e.target.value})}
                      className="p-4 rounded-2xl border-4 border-black text-xl font-bold bg-yellow-50 focus:bg-white transition-colors h-32"
                      placeholder="복용 방법을 입력하세요"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-lg font-black text-gray-700">복용 시간</label>
                    <div className="flex gap-2">
                      {['morning', 'afternoon', 'evening'].map(s => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            const newSchedule = editingMed.schedule.includes(s)
                              ? editingMed.schedule.filter(item => item !== s)
                              : [...editingMed.schedule, s];
                            setEditingMed({...editingMed, schedule: newSchedule});
                          }}
                          className={`flex-1 py-3 rounded-xl border-4 border-black font-black text-lg transition-all ${
                            editingMed.schedule.includes(s) 
                            ? 'bg-blue-500 text-white shadow-none translate-x-1 translate-y-1' 
                            : 'bg-white text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]'
                          }`}
                        >
                          {s === 'morning' ? '아침' : s === 'afternoon' ? '점심' : '저녁'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 mt-2">
                  <Button 
                    onClick={() => handleApproveMed(editingMed)} 
                    variant="primary"
                    className="py-5 text-3xl"
                  >
                    확인 및 승인하기
                  </Button>
                  <p className="text-center text-gray-500 font-bold text-sm">
                    사진과 내용이 맞는지 꼭 확인해주세요!
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          {view === View.EDIT_MED && editingMed && (
            <motion.div 
              key="edit-med"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col gap-6"
            >
              <button 
                onClick={() => setView(profile?.role === 'solo' ? View.TODAY : View.SENIOR_DETAIL)} 
                className="flex items-center gap-2 text-2xl font-black mb-2"
              >
                <ChevronLeft className="w-8 h-8" /> 뒤로가기
              </button>

              <h2 className="text-3xl font-black">약 정보 수정</h2>
              
              <div className="bg-white p-6 rounded-[32px] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] flex flex-col gap-6">
                {editingMed.imageUrl && (
                  <div className="flex flex-col gap-2">
                    <p className="text-lg font-black text-blue-600">참고 사진</p>
                    <img 
                      src={editingMed.imageUrl} 
                      alt="Prescription" 
                      className="w-full rounded-2xl border-4 border-black object-cover max-h-48"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                )}

                <form onSubmit={handleUpdateMed} className="flex flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-xl font-bold">약 이름</label>
                    <input 
                      type="text" 
                      value={editingMed.name}
                      onChange={(e) => setEditingMed({...editingMed, name: e.target.value})}
                      className="p-4 rounded-2xl border-4 border-black text-2xl font-bold"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xl font-bold">주의사항</label>
                    <textarea 
                      value={editingMed.instructions}
                      onChange={(e) => setEditingMed({...editingMed, instructions: e.target.value})}
                      className="p-4 rounded-2xl border-4 border-black text-2xl font-bold h-32"
                    />
                  </div>
                  
                  <div className="flex flex-col gap-2">
                    <label className="text-xl font-bold">복용 시간</label>
                    <div className="flex gap-2">
                      {['morning', 'afternoon', 'evening'].map(s => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            const newSchedule = editingMed.schedule.includes(s)
                              ? editingMed.schedule.filter(item => item !== s)
                              : [...editingMed.schedule, s];
                            setEditingMed({...editingMed, schedule: newSchedule});
                          }}
                          className={`flex-1 py-3 rounded-xl border-4 border-black font-black text-lg ${
                            editingMed.schedule.includes(s) ? 'bg-blue-500 text-white' : 'bg-white text-black'
                          }`}
                        >
                          {s === 'morning' ? '아침' : s === 'afternoon' ? '점심' : '저녁'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <Button onClick={() => setView(profile?.role === 'solo' ? View.TODAY : View.SENIOR_DETAIL)} variant="secondary">취소</Button>
                    <Button type="submit" variant="primary">저장 완료</Button>
                  </div>
                </form>
              </div>
            </motion.div>
          )}

          {view === View.TODAY && (
            <motion.div 
              key="today"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex flex-col gap-6"
            >
              <button onClick={() => setView(View.MAIN)} className="flex items-center gap-2 text-3xl font-black mb-4">
                <ChevronLeft className="w-10 h-10" /> 처음으로
              </button>
              
              <h2 className="text-4xl font-black mb-4">오늘 먹을 약</h2>

              {medications.length === 0 ? (
                <div className="bg-white p-12 rounded-[40px] border-8 border-black text-center flex flex-col gap-6">
                  <p className="text-3xl font-bold">등록된 약이 없습니다.<br/>약을 먼저 등록해주세요!</p>
                  <Button onClick={seedMockData} variant="secondary">
                    예시 데이터 넣기
                  </Button>
                </div>
              ) : (
                medications.map(med => (
                  <div key={med.id} className={`p-6 rounded-[32px] border-4 border-black bg-white shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] ${med.takenToday ? 'opacity-60' : ''} overflow-hidden`}>
                    <div className="flex justify-between items-start mb-2 gap-2">
                      <h3 className="text-3xl font-black break-words flex-1">{med.name}</h3>
                      {med.takenToday && <CheckCircle2 className="w-10 h-10 text-green-600 flex-shrink-0" />}
                    </div>
                    <p className="text-xl font-bold text-gray-600 mb-4 break-words">
                      시간: {med.schedule.map(s => s === 'morning' ? '아침' : s === 'afternoon' ? '점심' : '저녁').join(', ')}
                    </p>
                    <p className="text-xl font-bold text-red-600 mb-6 break-words">
                      주의: {med.instructions}
                    </p>
                    {!med.takenToday && (
                      <div className="flex gap-3">
                        <Button onClick={() => handleTakeMed(med)} variant="primary" className="flex-1">
                          먹었어요!
                        </Button>
                        {profile?.role === 'solo' && (
                          <Button 
                            onClick={() => {
                              setEditingMed(med);
                              setView(View.EDIT_MED);
                            }} 
                            variant="secondary"
                            className="px-4"
                          >
                            수정
                          </Button>
                        )}
                      </div>
                    )}
                    {med.takenToday && profile?.role === 'solo' && (
                      <div className="mt-4">
                        <Button 
                          onClick={() => {
                            setEditingMed(med);
                            setView(View.EDIT_MED);
                          }} 
                          variant="secondary"
                          className="w-full"
                        >
                          정보 수정하기
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </motion.div>
          )}

          {view === View.COUNT_MED && (
            <motion.div 
              key="count-med"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex flex-col gap-8"
            >
              <button onClick={() => setView(View.MAIN)} className="flex items-center gap-2 text-3xl font-black mb-4">
                <ChevronLeft className="w-10 h-10" /> 처음으로
              </button>

              <h2 className="text-4xl font-black mb-4">약 갯수 등록</h2>

              <div className="bg-white p-8 rounded-[32px] border-4 border-black text-center">
                <div className="mb-6 flex justify-center">
                  <Hash className="w-24 h-24 text-blue-500" />
                </div>
                <p className="text-2xl font-bold mb-8">약봉지들을 길게 펴서<br/>사진을 찍어주세요.</p>
                
                {isCounting ? (
                  <div className="flex flex-col items-center gap-4 py-12">
                    <Loader2 className="animate-spin w-16 h-16 text-blue-500" />
                    <p className="text-2xl font-black">갯수 세는 중...</p>
                  </div>
                ) : (
                  <CameraCapture 
                    onCapture={handleCountPouches}
                    onCancel={() => setView(View.MAIN)}
                    guideText="약봉지들을 길게 펴서 이 칸에 맞춰주세요"
                  />
                )}
              </div>
            </motion.div>
          )}

          {view === View.ADD && (
            <motion.div 
              key="add"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex flex-col gap-8"
            >
              <button onClick={() => { setView(View.MAIN); setIsCameraOpen(false); }} className="flex items-center gap-2 text-3xl font-black mb-4">
                <ChevronLeft className="w-10 h-10" /> 처음으로
              </button>

              <h2 className="text-4xl font-black mb-4">약 등록하기</h2>

              {isCameraOpen ? (
                <CameraCapture 
                  onCapture={(base64) => {
                    handleFileUpload(base64);
                    setIsCameraOpen(false);
                  }}
                  onCancel={() => setIsCameraOpen(false)}
                />
              ) : (
                <div className="bg-white p-8 rounded-[32px] border-4 border-black text-center">
                  <div className="mb-6 flex justify-center">
                    <Camera className="w-24 h-24 text-gray-400" />
                  </div>
                  <p className="text-2xl font-bold mb-8">약봉투 사진을 찍어서<br/>올려주세요.</p>
                  
                  <input 
                    type="file" 
                    accept="image/*" 
                    capture="environment"
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  
                  <div className="flex flex-col gap-4">
                    <Button 
                      onClick={() => setIsCameraOpen(true)} 
                      disabled={analyzing}
                      variant="primary"
                    >
                      {analyzing ? (
                        <div className="flex items-center justify-center gap-4">
                          <Loader2 className="animate-spin w-10 h-10" />
                          <span>분석 중...</span>
                        </div>
                      ) : '카메라로 찍기'}
                    </Button>
                    <Button 
                      onClick={() => fileInputRef.current?.click()} 
                      disabled={analyzing}
                      variant="secondary"
                    >
                      앨범에서 선택
                    </Button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {view === View.GUARDIAN && (
            <motion.div 
              key="guardian"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex flex-col gap-8"
            >
              <button onClick={() => setView(View.MAIN)} className="flex items-center gap-2 text-3xl font-black mb-4">
                <ChevronLeft className="w-10 h-10" /> 처음으로
              </button>

              <h2 className="text-4xl font-black mb-4">보호자 연결</h2>

              <div className="bg-white p-8 rounded-[32px] border-4 border-black text-center">
                <div className="mb-6 flex justify-center">
                  <Users className="w-24 h-24 text-blue-500" />
                </div>
                <p className="text-2xl font-bold mb-8">보호자에게 연락하거나<br/>상태를 공유합니다.</p>
                
                <Button variant="accent" onClick={() => speak("보호자에게 연락합니다.")}>
                  전화 걸기
                </Button>
              </div>
            </motion.div>
          )}

          {activeReminder && (
            <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4">
              <motion.div 
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="w-full max-w-[450px] bg-white rounded-[40px] border-8 border-blue-600 p-8 flex flex-col gap-6 text-center"
              >
                <div className="flex justify-center">
                  <Bell className="w-24 h-24 text-blue-600 animate-ring" />
                </div>
                <h2 className="text-4xl font-black text-blue-600">약 드실 시간!</h2>
                <p className="text-2xl font-bold">
                  {activeReminder === 'morning' ? '아침' : activeReminder === 'afternoon' ? '점심' : '저녁'} 약을 드실 시간입니다.
                </p>
                <div className="bg-blue-50 p-6 rounded-2xl border-4 border-blue-200">
                  <p className="text-xl font-bold">약을 드셨다면 "먹었어"라고 말씀하시거나 아래 버튼을 눌러주세요.</p>
                </div>
                
                <div className="flex flex-col gap-4">
                  <Button 
                    onClick={() => {
                      const scheduleToConfirm = activeReminder;
                      setActiveReminder(null);
                      const dueMeds = medications.filter(m => 
                        m.status === 'approved' && 
                        !m.takenToday && 
                        m.schedule.includes(scheduleToConfirm)
                      );
                      if (dueMeds.length > 0) {
                        handleTakeMed(dueMeds[0]);
                      } else {
                        setFeedback("복용할 약이 없습니다.");
                        setTimeout(() => setFeedback(null), 2000);
                      }
                    }} 
                    variant="primary"
                    className="py-6 text-2xl"
                  >
                    확인 (먹었어요)
                  </Button>
                  <Button 
                    onClick={() => setActiveReminder(null)} 
                    variant="secondary"
                  >
                    나중에
                  </Button>
                </div>
              </motion.div>
            </div>
          )}

          {isVerifying && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
              <div className="w-full max-w-[450px] bg-yellow-50 rounded-[40px] border-8 border-black p-6 flex flex-col gap-6">
                <h2 className="text-3xl font-black text-center">약 복용 확인</h2>
                <p className="text-xl font-bold text-center">남은 약봉지들을 펴서 찍어주세요.<br/>갯수를 확인합니다.</p>
                
                {isCounting ? (
                  <div className="flex flex-col items-center gap-4 py-12">
                    <Loader2 className="animate-spin w-16 h-16 text-blue-500" />
                    <p className="text-2xl font-black">갯수 확인 중...</p>
                  </div>
                ) : (
                  <CameraCapture 
                    onCapture={handleVerifyConsumption}
                    onCancel={() => {
                      setIsVerifying(false);
                      setVerifyingMed(null);
                    }}
                    guideText="남은 약봉지들을 이 칸에 맞춰주세요"
                  />
                )}
              </div>
            </div>
          )}

          {overDoseAlert && (
            <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4">
              <div className="w-full max-w-[450px] bg-white rounded-[40px] border-8 border-red-600 p-8 flex flex-col gap-6 text-center">
                <div className="flex justify-center">
                  <AlertTriangle className="w-24 h-24 text-red-600 animate-bounce" />
                </div>
                <h2 className="text-4xl font-black text-red-600">과복용 경고!</h2>
                <p className="text-2xl font-bold">
                  {overDoseAlert.medName} 약을<br/>
                  예상보다 더 많이 드신 것 같습니다.
                </p>
                <div className="bg-red-50 p-4 rounded-2xl border-4 border-red-200">
                  <p className="text-xl font-bold">예상 잔여: {overDoseAlert.expected}개</p>
                  <p className="text-xl font-bold text-red-600">실제 잔여: {overDoseAlert.actual}개</p>
                </div>
                <img 
                  src={overDoseAlert.imageUrl} 
                  alt="Verification" 
                  className="w-full h-48 object-cover rounded-2xl border-4 border-black"
                  referrerPolicy="no-referrer"
                />
                <Button onClick={() => setOverDoseAlert(null)} variant="danger">
                  확인했습니다
                </Button>
                {profile?.role === 'senior' && (
                  <p className="text-lg font-bold text-gray-500">보호자에게 알림이 전송되었습니다.</p>
                )}
              </div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Feedback Overlay */}
      <AnimatePresence>
        {feedback && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none p-6"
          >
            <div className="bg-white p-10 rounded-[50px] border-8 border-black shadow-[15px_15px_0px_0px_rgba(0,0,0,1)] w-full">
              <p className="text-5xl font-black text-center leading-tight">{feedback}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Alarm Simulation (Simple) */}
      <div className="hidden">
        <Volume2 />
      </div>
      </div>
    </div>
  );
}
